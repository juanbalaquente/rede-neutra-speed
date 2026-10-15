import { and, count, desc, eq, gte, like } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hashPassword, isStrongPassword, verifyPassword } from "./auth/password.js";
import { SESSION_COOKIE, signMfaChallenge, signSession, verifyMfaChallenge, verifySession, type Role, type SessionUser } from "./auth/session.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { auditLog, partners, photos, plans, portReservations, users } from "./db/schema.js";
import type { Integrations } from "./integrations/types.js";
import { IntegrationError } from "./integrations/types.js";
import { AppError, isUniqueViolation } from "./lib/errors.js";
import { recordAudit } from "./services/audit.js";
import * as mfa from "./services/mfa.js";
import { closeServiceOrder, getInstallation, getOsPhotosRequired, listAgenda, listInstallations, listTechnicians, reschedule, saveCliente, setOsPhotosRequired } from "./services/installations.js";
import { DEFAULT_SIGNAL_LIMIT_DB, decideActivation, getActivation, getSignalLimit, listActivations, listPendingOnus, setSignalLimit, startActivation } from "./services/activations.js";
import { conferirCsv, conferirReport } from "./services/conferir-report.js";
import { networkPanel } from "./services/network-panel.js";
import { cancelReservation, createReservation, listReservations } from "./services/reservations.js";
import { runViability } from "./services/viability.js";
import { createPhotoLink, listPhotos, ownPhoto, photoView, readPhoto, uploadPhoto, verifyPhotoLink } from "./services/photos.js";
import type { PhotoStorage } from "./storage/photos.js";
import { PHOTO_KINDS } from "./db/schema.js";

export interface AppDeps {
  db: Db;
  config: Config;
  integrations: Integrations;
  photoStorage: PhotoStorage;
}

type Env = { Variables: { user: SessionUser; userRow: typeof users.$inferSelect } };

function clientIp(c: Context): string | null {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

async function parseBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "dados_invalidos", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export function createApp({ db, config, integrations, photoStorage }: AppDeps) {
  const app = new Hono<Env>().basePath("/api");

  // Conta só tentativas que falharam; login certo zera o contador.
  const failedLogins = new Map<string, { n: number; resetAt: number }>();
  const isLoginLocked = (key: string) => {
    const entry = failedLogins.get(key);
    return !!entry && entry.resetAt > Date.now() && entry.n >= 10;
  };
  const registerLoginFailure = (key: string) => {
    const now = Date.now();
    const entry = failedLogins.get(key);
    if (!entry || entry.resetAt < now) failedLogins.set(key, { n: 1, resetAt: now + 15 * 60_000 });
    else entry.n += 1;
  };

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof IntegrationError) {
      console.error(err);
      return c.json({ error: "sistema_indisponivel", message: "A consulta à rede da Speed está indisponível agora. Tente de novo em alguns minutos." }, 502);
    }
    console.error(err);
    return c.json({ error: "erro_interno", message: "Erro interno." }, 500);
  });

  /** Valida a sessão e recarrega usuário e parceiro do banco a cada requisição. */
  const requireUser: MiddlewareHandler<Env> = async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const token = getCookie(c, SESSION_COOKIE) ?? bearer;
    const session = token ? await verifySession(token, config.SESSION_SECRET) : null;
    if (!session) throw new AppError(401, "nao_autenticado", "Faça login.");
    const [row] = await db
      .select({ user: users, partnerStatus: partners.status })
      .from(users)
      .leftJoin(partners, eq(users.partnerId, partners.id))
      .where(eq(users.id, session.id));
    if (!row || !row.user.active) throw new AppError(401, "nao_autenticado", "Usuário inativo.");
    if (row.user.role !== "admin_speed" && row.partnerStatus !== "ativo") {
      throw new AppError(403, "parceiro_bloqueado", "Acesso do parceiro bloqueado. Fale com a Speed.");
    }
    c.set("user", { id: row.user.id, partnerId: row.user.partnerId, role: row.user.role, name: row.user.name });
    c.set("userRow", row.user);
    // Supervisor e administrador sem segundo fator só alcançam a configuração dele.
    if (mfa.mfaState(config, row.user).setupRequired && !c.req.path.startsWith("/api/auth/")) {
      throw new AppError(403, "mfa_obrigatorio", "Configure o segundo fator para continuar.");
    }
    await next();
  };

  const requireRole =
    (...roles: Role[]): MiddlewareHandler<Env> =>
    async (c, next) => {
      if (!roles.includes(c.get("user").role)) throw new AppError(403, "sem_permissao", "Sem permissão para esta ação.");
      await next();
    };

  app.get("/health", (c) => c.json({ ok: true, integrations: config.INTEGRATIONS_MODE }));

  // ── Autenticação ──────────────────────────────────────────────────────────
  app.post("/auth/login", async (c) => {
    const body = await parseBody(c, z.object({ email: z.string().email(), password: z.string().min(1) }));
    const email = body.email.toLowerCase();
    const attemptKey = `${clientIp(c)}:${email}`;
    if (isLoginLocked(attemptKey)) throw new AppError(429, "muitas_tentativas", "Muitas tentativas. Aguarde 15 minutos.");
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const ok = user?.active && (await verifyPassword(body.password, user.passwordHash));
    if (!user || !ok) {
      registerLoginFailure(attemptKey);
      throw new AppError(401, "credenciais_invalidas", "E-mail ou senha incorretos.");
    }
    // Senha certa mas segundo fator ligado: ainda não há sessão. O contador de falhas só zera depois do código.
    if (user.totpEnabled) {
      return c.json({ mfa: "required", challenge: await signMfaChallenge(user.id, config.SESSION_SECRET) });
    }
    failedLogins.delete(attemptKey);
    return c.json(await startSession(c, user, false));
  });

  /** Emite o cookie de sessão e registra a entrada. */
  async function startSession(c: Context, user: typeof users.$inferSelect, viaMfa: boolean) {
    const session: SessionUser = { id: user.id, partnerId: user.partnerId, role: user.role, name: user.name };
    const token = await signSession(session, config.SESSION_SECRET, config.SESSION_HOURS);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.NODE_ENV === "production",
      path: "/",
      maxAge: config.SESSION_HOURS * 3600,
    });
    await recordAudit(db, { partnerId: user.partnerId, userId: user.id, action: "auth.login", ip: clientIp(c), data: viaMfa ? { segundoFator: true } : undefined });
    return { user: session, mfa: mfa.mfaState(config, user) };
  }

  /** Segundo passo do login: o código do app (ou um código de recuperação) troca o desafio por uma sessão. */
  app.post("/auth/login/2fa", async (c) => {
    const body = await parseBody(
      c,
      z.object({ challenge: z.string().min(10), code: z.string().trim().max(10).optional(), recoveryCode: z.string().trim().max(20).optional() }),
    );
    const userId = await verifyMfaChallenge(body.challenge, config.SESSION_SECRET);
    if (!userId) throw new AppError(401, "desafio_expirado", "A verificação expirou. Entre de novo com e-mail e senha.");
    const attemptKey = `2fa:${clientIp(c)}:${userId}`;
    if (isLoginLocked(attemptKey)) throw new AppError(429, "muitas_tentativas", "Muitas tentativas. Aguarde 15 minutos.");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const ok = !!user?.active && (await mfa.verifyLogin(db, config, user, body, new Date(), clientIp(c)));
    if (!user || !ok) {
      registerLoginFailure(attemptKey);
      if (user) await recordAudit(db, { partnerId: user.partnerId, userId: user.id, action: "auth.2fa_falhou", ip: clientIp(c) });
      throw new AppError(401, "codigo_invalido", "Código incorreto.");
    }
    failedLogins.delete(attemptKey);
    return c.json(await startSession(c, user, true));
  });

  // ── Segundo fator (TOTP) ──────────────────────────────────────────────────
  app.post("/auth/2fa/setup", requireUser, async (c) => c.json(await mfa.startSetup(db, config, c.get("userRow"))));

  app.post("/auth/2fa/enable", requireUser, async (c) => {
    const body = await parseBody(c, z.object({ code: z.string().trim().regex(/^\d{6}$/, "6 dígitos") }));
    const user = c.get("userRow");
    const key = `2fa-enable:${user.id}`;
    if (isLoginLocked(key)) throw new AppError(429, "muitas_tentativas", "Muitas tentativas. Aguarde 15 minutos.");
    try {
      const recoveryCodes = await mfa.enable(db, config, user, body.code, new Date(), clientIp(c));
      failedLogins.delete(key);
      return c.json({ recoveryCodes });
    } catch (e) {
      if (e instanceof AppError && e.code === "codigo_invalido") registerLoginFailure(key);
      throw e;
    }
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/auth/me", requireUser, (c) => c.json({ user: c.get("user"), mfa: mfa.mfaState(config, c.get("userRow")) }));

  /** Nome e limites do parceiro da sessão. Administrador Speed não tem parceiro. */
  app.get("/partner", requireUser, async (c) => {
    const { partnerId } = c.get("user");
    if (!partnerId) return c.json({ partner: null });
    const [partner] = await db
      .select({
        id: partners.id,
        name: partners.name,
        code: partners.code,
        maxActiveReservations: partners.maxActiveReservations,
        maxCtoOccupancyPct: partners.maxCtoOccupancyPct,
        maxUsers: partners.maxUsers,
        allowedRegions: partners.allowedRegions,
      })
      .from(partners)
      .where(eq(partners.id, partnerId));
    return c.json({ partner: partner ?? null });
  });

  // ── Viabilidade ───────────────────────────────────────────────────────────
  app.post("/viability", requireUser, async (c) => {
    const body = await parseBody(c, z.object({ address: z.string().min(8).max(300) }));
    return c.json(await runViability(db, integrations.network, c.get("user"), body.address, { ip: clientIp(c) }));
  });

  // ── Reservas ──────────────────────────────────────────────────────────────
  app.get("/reservations", requireUser, async (c) => {
    const status = z.enum(["ativa", "convertida", "cancelada", "expirada"]).optional().parse(c.req.query("status") || undefined);
    return c.json({ reservations: await listReservations(db, c.get("user"), status) });
  });

  app.post("/reservations", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        ctoId: z.string().min(1).max(120),
        address: z.string().min(8).max(300),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      }),
    );
    const created = await createReservation(db, integrations.network, c.get("user"), body, {
      hours: config.RESERVATION_HOURS,
      ip: clientIp(c),
    });
    return c.json({ reservation: created }, 201);
  });

  app.post("/reservations/:id/cancel", requireUser, async (c) => {
    const body = await parseBody(c, z.object({ reason: z.string().max(500).nullable().optional() }));
    const id = z.string().uuid().parse(c.req.param("id"));
    const updated = await cancelReservation(db, c.get("user"), id, body.reason ?? null, { ip: clientIp(c) });
    return c.json({ reservation: updated });
  });

  // ── Liberação de ONU (desligada por padrão: ACTIVATION_MODE) ───────────────
  const activationSvc = () => {
    if (!integrations.activation) throw new AppError(503, "ativacao_desligada", "A liberação de ONU não está habilitada.");
    return integrations.activation;
  };
  const activationView = (a: Awaited<ReturnType<typeof getActivation>>) => ({
    id: a.id,
    reservationId: a.reservationId,
    serial: a.serial,
    contract: a.contract,
    pppLogin: a.pppLogin,
    sinalCtoDbm: a.sinalCtoDbm,
    limiteDb: a.limiteDb,
    state: a.state,
    snapshot: a.snapshot,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });

  app.get("/activations", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    activationSvc();
    return c.json({ activations: (await listActivations(db, c.get("user"))).map(activationView) });
  });

  app.get("/reservations/:id/onus-pendentes", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    return c.json({ onus: await listPendingOnus(db, activationSvc(), c.get("user"), id) });
  });

  app.post("/activations", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        reservationId: z.string().uuid(),
        serial: z.string().trim().min(6).max(40).regex(/^[A-Za-z0-9]+$/, "serial só com letras e números"),
        contrato: z.string().regex(/^\d{1,12}$/, "número do contrato, só dígitos"),
        sinalCtoDbm: z.number().min(-40).max(0),
        idempotencyKey: z.string().uuid().optional(),
      }),
    );
    const created = await startActivation(db, activationSvc(), c.get("user"), body, { ip: clientIp(c) });
    return c.json({ activation: activationView(created) }, 202);
  });

  app.get("/activations/:id", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    return c.json({ activation: activationView(await getActivation(db, activationSvc(), c.get("user"), id)) });
  });

  app.post("/activations/:id/decision", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseBody(
      c,
      z.discriminatedUnion("acao", [
        z.object({ acao: z.literal("remedir") }),
        z.object({ acao: z.literal("cancelar") }),
        z.object({ acao: z.literal("prosseguir"), justificativa: z.string().max(1000) }),
      ]),
    );
    return c.json({ activation: activationView(await decideActivation(db, activationSvc(), c.get("user"), id, body, { ip: clientIp(c) })) });
  });

  // ── Fotos de campo ────────────────────────────────────────────────────────
  const photoMaxBytes = config.PHOTO_MAX_MB * 1024 * 1024;
  const optionalNumber = (min: number, max: number) =>
    z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().min(min).max(max).optional());

  app.post(
    "/reservations/:id/photos",
    requireUser,
    requireRole("atendente", "supervisor"),
    // Folga para os campos do formulário além do arquivo.
    bodyLimit({
      maxSize: photoMaxBytes + 64 * 1024,
      onError: () => {
        throw new AppError(422, "foto_grande_demais", `A foto passa de ${config.PHOTO_MAX_MB} MB.`);
      },
    }),
    async (c) => {
      const reservationId = z.string().uuid().parse(c.req.param("id"));
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
      const file = form.file;
      if (!(file instanceof File)) throw new AppError(400, "dados_invalidos", "file: envie a foto no campo \"file\".");
      const meta = z
        .object({
          kind: z.enum(PHOTO_KINDS),
          lat: optionalNumber(-90, 90),
          lng: optionalNumber(-180, 180),
          accuracyM: optionalNumber(0, 100000),
          capturedAt: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().datetime({ offset: true }).optional()),
        })
        .safeParse(form);
      if (!meta.success) {
        throw new AppError(400, "dados_invalidos", meta.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const created = await uploadPhoto(
        db,
        photoStorage,
        c.get("user"),
        {
          reservationId,
          kind: meta.data.kind,
          bytes: new Uint8Array(await file.arrayBuffer()),
          lat: meta.data.lat,
          lng: meta.data.lng,
          accuracyM: meta.data.accuracyM,
          capturedAt: meta.data.capturedAt ? new Date(meta.data.capturedAt) : null,
        },
        { maxBytes: photoMaxBytes, ip: clientIp(c) },
      );
      return c.json({ photo: photoView(created) }, 201);
    },
  );

  app.get("/reservations/:id/photos", requireUser, async (c) => {
    const reservationId = z.string().uuid().parse(c.req.param("id"));
    return c.json({ photos: (await listPhotos(db, c.get("user"), reservationId)).map(photoView) });
  });

  /** O arquivo, só para quem pode ver a foto. Nunca público e nunca em cache compartilhado. */
  app.get("/photos/:id/file", requireUser, async (c) => {
    const photo = await ownPhoto(db, c.get("user"), z.string().uuid().parse(c.req.param("id")));
    const bytes = await readPhoto(photoStorage, photo);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": photo.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  });

  /** Link assinado para mostrar a foto a quem não tem conta (a Infra). Vale no máximo 48 h. */
  app.post("/photos/:id/link", requireUser, async (c) => {
    const body = await parseBody(c, z.object({ hours: z.number().int().min(1).max(48).default(48) }));
    const link = await createPhotoLink(db, c.get("user"), z.string().uuid().parse(c.req.param("id")), {
      hours: body.hours,
      secret: config.SESSION_SECRET,
      baseUrl: config.PUBLIC_BASE_URL,
      ip: clientIp(c),
    });
    return c.json(link, 201);
  });

  /** Sem login: o token assinado é a credencial. Qualquer falha responde 404, sem dizer se expirou ou é inválido. */
  app.get("/photos/shared/:token", async (c) => {
    const photoId = verifyPhotoLink(c.req.param("token"), config.SESSION_SECRET);
    const notFound = new AppError(404, "foto_nao_encontrada", "Foto não encontrada.");
    if (!photoId) throw notFound;
    const [photo] = await db.select().from(photos).where(eq(photos.id, photoId));
    if (!photo) throw notFound;
    const bytes = await readPhoto(photoStorage, photo);
    await recordAudit(db, { partnerId: photo.partnerId, userId: null, action: "foto.vista_por_link", entity: "photo", entityId: photo.id, ip: clientIp(c) });
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": photo.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  });

  // ── Instalações e fechamento da O.S. ────────────────────────────────────────
  app.get("/installations", requireUser, async (c) => c.json({ installations: await listInstallations(db, c.get("user")) }));

  app.get("/installations/:id", requireUser, async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    return c.json({ installation: await getInstallation(db, c.get("user"), id) });
  });

  /** Plano, apelido, data da visita e técnico: o formulário do contrato do cliente. */
  app.patch("/reservations/:id/cliente", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseBody(
      c,
      z.object({
        planId: z.string().uuid(),
        nickname: z.string().trim().max(120).nullable().optional(),
        visitAt: z.string().datetime({ offset: true }),
        technician: z.string().trim().min(2).max(120),
      }),
    );
    await saveCliente(db, c.get("user"), id, { ...body, visitAt: new Date(body.visitAt) }, { ip: clientIp(c) });
    return c.json({ installation: await getInstallation(db, c.get("user"), id) });
  });

  /** Visitas do intervalo [from, to): alimenta o calendário (dia, semana e mês). */
  app.get("/agenda", requireUser, async (c) => {
    const q = z
      .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
      .safeParse(Object.fromEntries(Object.entries(c.req.query())));
    if (!q.success) throw new AppError(400, "dados_invalidos", "Informe from e to (ISO 8601 com fuso).");
    const from = new Date(q.data.from);
    const to = new Date(q.data.to);
    if (to <= from || to.getTime() - from.getTime() > 62 * 24 * 3600_000) {
      throw new AppError(400, "dados_invalidos", "Intervalo inválido (máximo de 62 dias).");
    }
    return c.json({ visits: await listAgenda(db, c.get("user"), { from, to }) });
  });

  /** Arrastar o card para outro dia ou editar data e técnico. */
  app.patch("/reservations/:id/visita", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseBody(c, z.object({ visitAt: z.string().datetime({ offset: true }), technician: z.string().trim().min(2).max(120).optional() }));
    await reschedule(db, c.get("user"), id, { visitAt: new Date(body.visitAt), technician: body.technician }, { ip: clientIp(c) });
    return c.json({ installation: await getInstallation(db, c.get("user"), id) });
  });

  app.get("/technicians", requireUser, requireRole("atendente", "supervisor"), async (c) => c.json({ technicians: await listTechnicians(db, c.get("user")) }));

  app.post("/reservations/:id/os/close", requireUser, requireRole("atendente", "supervisor"), async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseBody(
      c,
      z.object({
        porta: z.string().trim().max(20).nullable().optional(),
        sinalFinalDbm: z.number().min(-40).max(0),
        modeloOnu: z.string().trim().min(2).max(60),
        serialOnu: z.string().trim().min(6).max(40).regex(/^[A-Za-z0-9]+$/, "serial só com letras e números"),
        observacao: z.string().trim().max(1000).nullable().optional(),
      }),
    );
    await closeServiceOrder(db, c.get("user"), id, { ...body, serialOnu: body.serialOnu.toUpperCase() }, { ip: clientIp(c) });
    return c.json({ installation: await getInstallation(db, c.get("user"), id) });
  });

  // ── Planos ────────────────────────────────────────────────────────────────
  app.get("/plans", requireUser, async (c) => {
    const rows = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.speedMbps);
    return c.json({ plans: rows });
  });

  // ── Usuários do parceiro (supervisor gerencia os dele) ────────────────────
  /** Siglas de região liberadas ao parceiro (R1, ITA, FAT...). Vazio = nenhuma CTO é oferecida. */
  const regionsSchema = z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, "sigla de 1 a 8 letras ou números")).max(50);

  /** Código curto do provedor no login PPPoE (`<contrato>-JHV`): maiúsculas e números, sem hífen. */
  const partnerCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, "código de 2 a 8 letras ou números");

  const newUserSchema = z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    password: z.string().refine(isStrongPassword, "senha precisa de 10+ caracteres, letra e número"),
    role: z.enum(["atendente", "supervisor"]),
    partnerId: z.string().uuid().optional(),
  });

  app.get("/users", requireUser, requireRole("supervisor", "admin_speed"), async (c) => {
    const me = c.get("user");
    const partnerId = me.role === "admin_speed" ? c.req.query("partnerId") : me.partnerId!;
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, partnerId: users.partnerId, totpEnabled: users.totpEnabled })
      .from(users)
      .where(partnerId ? eq(users.partnerId, partnerId) : undefined)
      .orderBy(users.name);
    return c.json({ users: rows });
  });

  app.post("/users", requireUser, requireRole("supervisor", "admin_speed"), async (c) => {
    const me = c.get("user");
    const body = await parseBody(c, newUserSchema);
    const partnerId = me.role === "admin_speed" ? body.partnerId : me.partnerId!;
    if (!partnerId) throw new AppError(422, "parceiro_obrigatorio", "Informe o parceiro.");
    const [partner] = await db.select().from(partners).where(eq(partners.id, partnerId));
    if (!partner) throw new AppError(404, "parceiro_nao_encontrado", "Parceiro não encontrado.");
    const [active] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.partnerId, partnerId), eq(users.active, true)));
    if (Number(active?.n ?? 0) >= partner.maxUsers) {
      throw new AppError(409, "limite_usuarios", `Limite de ${partner.maxUsers} usuários atingido.`);
    }
    try {
      const [created] = await db
        .insert(users)
        .values({
          partnerId,
          name: body.name,
          email: body.email.toLowerCase(),
          passwordHash: await hashPassword(body.password),
          role: body.role,
        })
        .returning({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active });
      await recordAudit(db, { partnerId, userId: me.id, action: "usuario.criado", entity: "user", entityId: created!.id, ip: clientIp(c) });
      return c.json({ user: created }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, "email_em_uso", "Já existe usuário com esse e-mail.");
      throw e;
    }
  });

  app.post("/users/:id/active", requireUser, requireRole("supervisor", "admin_speed"), async (c) => {
    const me = c.get("user");
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseBody(c, z.object({ active: z.boolean() }));
    if (id === me.id) throw new AppError(422, "proprio_usuario", "Você não pode desativar a si mesmo.");
    const scope = me.role === "admin_speed" ? eq(users.id, id) : and(eq(users.id, id), eq(users.partnerId, me.partnerId!));
    // Reativar conta para o limite de usuários, como criar.
    if (body.active) {
      const [target] = await db.select({ partnerId: users.partnerId, active: users.active }).from(users).where(scope);
      if (!target) throw new AppError(404, "usuario_nao_encontrado", "Usuário não encontrado.");
      if (!target.active && target.partnerId) {
        const [partner] = await db.select().from(partners).where(eq(partners.id, target.partnerId));
        const [active] = await db
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.partnerId, target.partnerId), eq(users.active, true)));
        if (partner && Number(active?.n ?? 0) >= partner.maxUsers) {
          throw new AppError(409, "limite_usuarios", `Limite de ${partner.maxUsers} usuários atingido.`);
        }
      }
    }
    const [updated] = await db.update(users).set({ active: body.active }).where(scope).returning({ id: users.id, partnerId: users.partnerId });
    if (!updated) throw new AppError(404, "usuario_nao_encontrado", "Usuário não encontrado.");
    await recordAudit(db, {
      partnerId: updated.partnerId,
      userId: me.id,
      action: body.active ? "usuario.ativado" : "usuario.desativado",
      entity: "user",
      entityId: id,
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });

  // ── Administração Speed ───────────────────────────────────────────────────
  const admin = new Hono<Env>();
  admin.use(requireUser, requireRole("admin_speed"));

  /** Parceiros com o uso atual (reservas abertas e usuários ativos), para a tela de gestão. */
  admin.get("/partners", async (c) => {
    const rows = await db.select().from(partners).orderBy(partners.name);
    const open = await db
      .select({ partnerId: portReservations.partnerId, n: count() })
      .from(portReservations)
      .where(eq(portReservations.status, "ativa"))
      .groupBy(portReservations.partnerId);
    const people = await db
      .select({ partnerId: users.partnerId, n: count() })
      .from(users)
      .where(eq(users.active, true))
      .groupBy(users.partnerId);
    const openBy = new Map(open.map((r) => [r.partnerId, Number(r.n)]));
    const peopleBy = new Map(people.map((r) => [r.partnerId, Number(r.n)]));
    return c.json({
      partners: rows.map((p) => ({ ...p, activeReservations: openBy.get(p.id) ?? 0, activeUsers: peopleBy.get(p.id) ?? 0 })),
    });
  });

  admin.post("/partners", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        name: z.string().min(2).max(200),
        cnpj: z.string().regex(/^\d{14}$/, "CNPJ com 14 dígitos, sem pontuação"),
        code: partnerCodeSchema.optional(),
        maxActiveReservations: z.number().int().min(1).max(1000).optional(),
        maxCtoOccupancyPct: z.number().int().min(1).max(100).optional(),
        maxUsers: z.number().int().min(1).max(500).optional(),
        allowedRegions: regionsSchema.optional(),
      }),
    );
    try {
      const [created] = await db.insert(partners).values(body).returning();
      await recordAudit(db, { partnerId: created!.id, userId: c.get("user").id, action: "parceiro.criado", entity: "partner", entityId: created!.id, ip: clientIp(c) });
      return c.json({ partner: created }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, "cnpj_em_uso", "Já existe parceiro com esse CNPJ ou código.");
      throw e;
    }
  });

  admin.patch("/partners/:id", async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseBody(
      c,
      z
        .object({
          status: z.enum(["ativo", "bloqueado"]),
          code: partnerCodeSchema,
          maxActiveReservations: z.number().int().min(1).max(1000),
          maxCtoOccupancyPct: z.number().int().min(1).max(100),
          maxUsers: z.number().int().min(1).max(500),
          allowedRegions: regionsSchema,
          /** Obrigatória para bloquear (confirmação dupla no front + registro aqui). */
          reason: z.string().max(500),
        })
        .partial(),
    );
    if (body.status === "bloqueado" && !body.reason?.trim()) {
      throw new AppError(422, "motivo_obrigatorio", "Informe o motivo do bloqueio.");
    }
    const { reason, ...changes } = body;
    if (Object.keys(changes).length === 0) throw new AppError(400, "nada_a_alterar", "Nada para alterar.");
    let updated;
    try {
      [updated] = await db.update(partners).set(changes).where(eq(partners.id, id)).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, "codigo_em_uso", "Já existe parceiro com esse código.");
      throw e;
    }
    if (!updated) throw new AppError(404, "parceiro_nao_encontrado", "Parceiro não encontrado.");
    await recordAudit(db, { partnerId: id, userId: c.get("user").id, action: "parceiro.alterado", entity: "partner", entityId: id, ip: clientIp(c), data: { changes, reason } });
    return c.json({ partner: updated });
  });

  /** Se as fotos do checklist são obrigatórias para fechar a O.S. (planejamento recomenda que sim). */
  admin.get("/settings/fotos-os", async (c) => c.json({ obrigatorias: await getOsPhotosRequired(db) }));

  admin.put("/settings/fotos-os", async (c) => {
    const body = await parseBody(c, z.object({ obrigatorias: z.boolean() }));
    return c.json({ obrigatorias: await setOsPhotosRequired(db, c.get("user"), body.obrigatorias, clientIp(c)) });
  });

  /** Celular perdido: apaga o segundo fator do usuário. Na próxima entrada ele configura de novo. */
  admin.post("/users/:id/2fa/reset", async (c) => {
    const id = z.string().uuid().parse(c.req.param("id"));
    if (id === c.get("user").id) throw new AppError(422, "proprio_usuario", "Para o seu próprio acesso, use o comando de recuperação no servidor.");
    const target = await mfa.resetFor(db, id, c.get("user").id, clientIp(c));
    return c.json({ ok: true, user: { id: target.id, name: target.name } });
  });

  /** Perda máxima de sinal entre a CTO e a ONU (dB). Parâmetro da Speed; cada ativação guarda o limite que valeu. */
  admin.get("/settings/limite-sinal", async (c) => c.json({ limiteDb: await getSignalLimit(db), padraoDb: DEFAULT_SIGNAL_LIMIT_DB }));

  admin.put("/settings/limite-sinal", async (c) => {
    const body = await parseBody(c, z.object({ limiteDb: z.number().min(0.5).max(6) }));
    return c.json({ limiteDb: await setSignalLimit(db, c.get("user"), body.limiteDb, clientIp(c)) });
  });

  /** Estado da integração com a rede (Wiki, direto ou mock). 401/403 da Wiki aparece aqui como chave recusada. */
  admin.get("/integrations/health", async (c) => {
    const health = await integrations.network.health();
    return c.json({ mode: config.INTEGRATIONS_MODE, ...health });
  });

  /** CTOs mais encontradas em "conferir" nas consultas: por onde a Speed começa a limpar o cadastro. ?format=csv baixa a planilha. */
  admin.get("/cto-conferir", async (c) => {
    const parsed = z.coerce.number().int().min(1).max(365).default(30).safeParse(c.req.query("days") || undefined);
    if (!parsed.success) throw new AppError(400, "dados_invalidos", "days: informe de 1 a 365.");
    const days = parsed.data;
    const rows = await conferirReport(db, days);
    if (c.req.query("format") === "csv") {
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="ctos-conferir-${days}d.csv"`);
      return c.body(conferirCsv(rows));
    }
    return c.json({ days, rows });
  });

  /** Painel da Speed: consultas por dia e estado das CTOs vistas, por sigla. */
  admin.get("/painel", async (c) => {
    const parsed = z.coerce.number().int().min(1).max(90).default(30).safeParse(c.req.query("days") || undefined);
    if (!parsed.success) throw new AppError(400, "dados_invalidos", "days: informe de 1 a 90.");
    return c.json(await networkPanel(db, parsed.data));
  });

  /** Trilha de auditoria com nome de quem fez e do parceiro. Filtros: parceiro, prefixo de ação, período. */
  admin.get("/audit", async (c) => {
    const parsed = z
      .object({
        partnerId: z.string().uuid().optional(),
        action: z.string().regex(/^[a-z_.]{1,40}$/).optional(),
        days: z.coerce.number().int().min(1).max(365).default(30),
        limit: z.coerce.number().int().min(1).max(1000).default(300),
      })
      .safeParse(Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== "")));
    if (!parsed.success) throw new AppError(400, "dados_invalidos", "Filtro inválido.");
    const q = parsed.data;
    const filters = [gte(auditLog.createdAt, new Date(Date.now() - q.days * 24 * 3600_000))];
    if (q.partnerId) filters.push(eq(auditLog.partnerId, q.partnerId));
    if (q.action) filters.push(like(auditLog.action, `${q.action}%`));
    const rows = await db
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        ip: auditLog.ip,
        data: auditLog.data,
        partnerId: auditLog.partnerId,
        partnerName: partners.name,
        userId: auditLog.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .leftJoin(partners, eq(partners.id, auditLog.partnerId))
      .where(and(...filters))
      .orderBy(desc(auditLog.id))
      .limit(q.limit);
    return c.json({ entries: rows });
  });

  app.route("/admin", admin);
  return app;
}
