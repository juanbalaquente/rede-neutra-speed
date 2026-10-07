import { and, count, desc, eq } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hashPassword, isStrongPassword, verifyPassword } from "./auth/password.js";
import { SESSION_COOKIE, signSession, verifySession, type Role, type SessionUser } from "./auth/session.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { auditLog, partners, plans, portReservations, users } from "./db/schema.js";
import type { Integrations } from "./integrations/types.js";
import { IntegrationError } from "./integrations/types.js";
import { AppError, isUniqueViolation } from "./lib/errors.js";
import { recordAudit } from "./services/audit.js";
import { conferirCsv, conferirReport } from "./services/conferir-report.js";
import { cancelReservation, createReservation, listReservations } from "./services/reservations.js";
import { runViability } from "./services/viability.js";

export interface AppDeps {
  db: Db;
  config: Config;
  integrations: Integrations;
}

type Env = { Variables: { user: SessionUser } };

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

export function createApp({ db, config, integrations }: AppDeps) {
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
      return c.json({ error: "sistema_indisponivel", message: `Sistema de origem indisponível (${err.system}).` }, 502);
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
    failedLogins.delete(attemptKey);
    const session: SessionUser = { id: user.id, partnerId: user.partnerId, role: user.role, name: user.name };
    const token = await signSession(session, config.SESSION_SECRET, config.SESSION_HOURS);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.NODE_ENV === "production",
      path: "/",
      maxAge: config.SESSION_HOURS * 3600,
    });
    await recordAudit(db, { partnerId: user.partnerId, userId: user.id, action: "auth.login", ip: clientIp(c) });
    return c.json({ user: session });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/auth/me", requireUser, (c) => c.json({ user: c.get("user") }));

  /** Nome e limites do parceiro da sessão. Administrador Speed não tem parceiro. */
  app.get("/partner", requireUser, async (c) => {
    const { partnerId } = c.get("user");
    if (!partnerId) return c.json({ partner: null });
    const [partner] = await db
      .select({
        id: partners.id,
        name: partners.name,
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

  // ── Planos ────────────────────────────────────────────────────────────────
  app.get("/plans", requireUser, async (c) => {
    const rows = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.speedMbps);
    return c.json({ plans: rows });
  });

  // ── Usuários do parceiro (supervisor gerencia os dele) ────────────────────
  /** Siglas de região liberadas ao parceiro (R1, ITA, FAT...). Vazio = nenhuma CTO é oferecida. */
  const regionsSchema = z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, "sigla de 1 a 8 letras ou números")).max(50);

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
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, partnerId: users.partnerId })
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
      if (isUniqueViolation(e)) throw new AppError(409, "cnpj_em_uso", "Já existe parceiro com esse CNPJ.");
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
    const [updated] = await db.update(partners).set(changes).where(eq(partners.id, id)).returning();
    if (!updated) throw new AppError(404, "parceiro_nao_encontrado", "Parceiro não encontrado.");
    await recordAudit(db, { partnerId: id, userId: c.get("user").id, action: "parceiro.alterado", entity: "partner", entityId: id, ip: clientIp(c), data: { changes, reason } });
    return c.json({ partner: updated });
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

  admin.get("/audit", async (c) => {
    const partnerId = c.req.query("partnerId");
    const rows = await db
      .select()
      .from(auditLog)
      .where(partnerId ? eq(auditLog.partnerId, partnerId) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(500);
    return c.json({ entries: rows });
  });

  app.route("/admin", admin);
  return app;
}
