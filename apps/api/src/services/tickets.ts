import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { TICKET_TYPES, activations, partners, photos, portReservations, settings, ticketMessages, tickets, type TicketType } from "../db/schema.js";
import type { TicketRemoteState, TicketService } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import { HOTSPOT_DAYS, HOTSPOT_MIN_TICKETS, ticketHotspots } from "./speed-overview.js";
import { LINK_MAX_HOURS, signPhotoLink } from "./photos.js";

type Ticket = typeof tickets.$inferSelect;

export const TICKET_LABEL: Record<TicketType, string> = {
  cto_com_problema: "CTO com problema, suja ou desorganizada",
  porta_off: "Porta off ou sem sinal",
  conferencia_porta: "Conferência de porta após divergência",
  sinal_fora_padrao_cto: "Sinal fora do padrão em toda a CTO",
  rompimento_regional: "Rompimento ou queda generalizada na região",
  trava_sinal: "Trava de sinal (automático)",
};

const FINAL_STATES = ["resolvido", "cancelado"];

// ── SLA por tipo, configurável pela Speed ────────────────────────────────────

export const SLA_KEY = "sla.horas";

/** Prazos provisórios: a diretoria ainda define os valores por tipo (planejamento). */
export const DEFAULT_SLA_HOURS: Record<TicketType, number> = {
  cto_com_problema: 48,
  porta_off: 24,
  conferencia_porta: 24,
  sinal_fora_padrao_cto: 48,
  rompimento_regional: 8,
  trava_sinal: 48,
};

export async function getSla(db: Db): Promise<Record<TicketType, number>> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, SLA_KEY));
  const saved = (row?.value ?? {}) as Partial<Record<TicketType, number>>;
  return Object.fromEntries(TICKET_TYPES.map((t) => [t, typeof saved[t] === "number" ? saved[t]! : DEFAULT_SLA_HOURS[t]])) as Record<TicketType, number>;
}

export async function setSla(db: Db, user: SessionUser, type: TicketType, hours: number, ip?: string | null) {
  const current = await getSla(db);
  const next = { ...current, [type]: hours };
  await db
    .insert(settings)
    .values({ key: SLA_KEY, value: next, updatedBy: user.id })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedBy: user.id, updatedAt: new Date() } });
  await recordAudit(db, { partnerId: null, userId: user.id, action: "config.sla", entity: "setting", entityId: SLA_KEY, ip, data: { tipo: type, before: current[type], after: hours } });
  return next;
}

// ── Chamados ─────────────────────────────────────────────────────────────────

/** Onde e como o portal fala com a Wiki: serviço (ou ausente), segredo para assinar os links das fotos e a URL pública. */
export interface TicketEnv {
  svc?: TicketService;
  linkSecret: string;
  baseUrl?: string;
}

export interface TicketInput {
  type: TicketType;
  description: string;
  reservationId?: string | null;
  ctoId?: string | null;
  signalDbm?: number | null;
  photoIds?: string[];
}

const hashOf = (...parts: string[]) => createHash("sha1").update(parts.join("|")).digest("hex");

/** Prazo e atraso calculados na leitura. */
export const ticketView = (t: Ticket, partnerName?: string | null) => ({
  id: t.id,
  origin: t.origin as "parceiro" | "sistema",
  type: t.type as TicketType,
  typeLabel: TICKET_LABEL[t.type as TicketType] ?? t.type,
  state: t.state,
  ctoName: t.ctoName,
  login: t.login,
  description: t.description,
  signalDbm: t.signalDbm,
  slaHours: t.slaHours,
  dueAt: t.dueAt,
  late: !FINAL_STATES.includes(t.state) && t.dueAt.getTime() < Date.now(),
  resolvedAt: t.resolvedAt,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  partnerName: partnerName ?? null,
});

/** Entrega (ou reentrega, com a mesma chave) o chamado à Wiki. Wiki fora do ar deixa "recebido"; repetir é seguro. */
async function deliver(db: Db, env: TicketEnv, t: Ticket): Promise<Ticket> {
  if (!env.svc) return t;
  const [partner] = await db.select({ code: partners.code, name: partners.name }).from(partners).where(eq(partners.id, t.partnerId));
  if (!partner?.code) return t;
  const ids = ((t.photoIds as string[] | null) ?? []).slice(0, 6);
  const rows = ids.length ? await db.select().from(photos).where(and(inArray(photos.id, ids), eq(photos.partnerId, t.partnerId))) : [];
  const expires = new Date(Date.now() + LINK_MAX_HOURS * 3600_000);
  const base = (env.baseUrl ?? "").replace(/\/$/, "");
  try {
    const created = await env.svc.create({
      idempotencyKey: t.idempotencyKey,
      tipo: t.type,
      origem: t.origin as "parceiro" | "sistema",
      parceiro: { codigo: partner.code, nome: partner.name },
      ctoId: t.ctoId,
      login: t.login,
      descricao: t.description,
      sinalMedidoDbm: t.signalDbm,
      slaHoras: t.slaHours,
      fotos: rows.map((p) => ({ tipo: p.kind, url: `${base}/api/photos/shared/${signPhotoLink(p.id, expires, env.linkSecret)}` })),
    });
    const [updated] = await db.update(tickets).set({ wikiTicketId: created.chamadoId, state: created.estado, updatedAt: new Date() }).where(eq(tickets.id, t.id)).returning();
    return updated!;
  } catch (e) {
    console.error("[chamado] entrega à Wiki falhou, fica recebido:", e instanceof Error ? e.message : e);
    return t;
  }
}

export async function createTicket(db: Db, env: TicketEnv, user: SessionUser, input: TicketInput, opts: { ip?: string | null; origin?: "parceiro" | "sistema" } = {}) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro abrem chamados.");
  const origin = opts.origin ?? "parceiro";
  if (origin === "parceiro" && input.type === "trava_sinal") {
    throw new AppError(422, "tipo_automatico", "O chamado da trava de sinal é aberto pelo sistema.");
  }
  let ctoId = input.ctoId ?? null;
  let ctoName: string | null = null;
  let login: string | null = null;
  if (input.reservationId) {
    const [r] = await db
      .select()
      .from(portReservations)
      .where(and(eq(portReservations.id, input.reservationId), eq(portReservations.partnerId, user.partnerId)));
    if (!r) throw new AppError(404, "reserva_nao_encontrada", "Cliente não encontrado.");
    ctoId = r.ctoId;
    ctoName = r.ctoName;
    const [a] = await db
      .select({ login: activations.pppLogin })
      .from(activations)
      .where(and(eq(activations.reservationId, r.id), eq(activations.state, "online")))
      .orderBy(desc(activations.createdAt))
      .limit(1);
    login = a?.login ?? null;
  }
  const photoIds = (input.photoIds ?? []).slice(0, 6);
  if (photoIds.length) {
    const own = await db.select({ id: photos.id }).from(photos).where(and(inArray(photos.id, photoIds), eq(photos.partnerId, user.partnerId)));
    if (own.length !== photoIds.length) throw new AppError(404, "foto_nao_encontrada", "Foto não encontrada.");
  }
  const sla = (await getSla(db))[input.type];
  const now = new Date();
  const [created] = await db
    .insert(tickets)
    .values({
      partnerId: user.partnerId,
      userId: user.id,
      origin,
      type: input.type,
      reservationId: input.reservationId ?? null,
      ctoId,
      ctoName,
      login,
      description: input.description,
      signalDbm: input.signalDbm ?? null,
      slaHours: sla,
      dueAt: new Date(now.getTime() + sla * 3600_000),
      idempotencyKey: randomUUID(),
      photoIds,
    })
    .returning();
  await db.insert(ticketMessages).values({ ticketId: created!.id, author: "sistema", body: origin === "sistema" ? "Chamado aberto automaticamente pela trava de sinal." : "Chamado aberto." });
  await recordAudit(db, { partnerId: user.partnerId, userId: user.id, action: "chamado.aberto", entity: "ticket", entityId: created!.id, ip: opts.ip, data: { tipo: input.type, origem: origin, cto: ctoName, slaHoras: sla } });
  // Muitos chamados do mesmo parceiro na mesma CTO: avisa a Speed na auditoria no momento em que cruza o limite.
  if (ctoId) {
    const hot = (await ticketHotspots(db)).find((h) => h.partnerId === user.partnerId && h.ctoId === ctoId);
    if (hot && hot.total === HOTSPOT_MIN_TICKETS) {
      await recordAudit(db, { partnerId: user.partnerId, userId: null, action: "chamado.muitos_na_cto", entity: "ticket", entityId: created!.id, data: { cto: ctoName ?? ctoId, total: hot.total, dias: HOTSPOT_DAYS } });
    }
  }
  return deliver(db, env, created!);
}

async function ownTicket(db: Db, user: SessionUser, id: string): Promise<Ticket> {
  const scope = user.role === "admin_speed" ? eq(tickets.id, id) : and(eq(tickets.id, id), eq(tickets.partnerId, user.partnerId!));
  const [row] = await db.select().from(tickets).where(scope);
  if (!row) throw new AppError(404, "chamado_nao_encontrado", "Chamado não encontrado.");
  return row;
}

export async function listTickets(db: Db, user: SessionUser) {
  const isAdmin = user.role === "admin_speed";
  const rows = await db
    .select({ t: tickets, partnerName: partners.name })
    .from(tickets)
    .leftJoin(partners, eq(partners.id, tickets.partnerId))
    .where(isAdmin ? undefined : eq(tickets.partnerId, user.partnerId!))
    .orderBy(desc(tickets.createdAt))
    .limit(200);
  return rows.map((r) => ticketView(r.t, isAdmin ? r.partnerName : null));
}

/** Chamado com o histórico. Enquanto está aberto, pergunta à Wiki: o estado e as mensagens da Infra entram aqui. */
export async function getTicket(db: Db, env: TicketEnv, user: SessionUser, id: string, refresh = true) {
  let t = await ownTicket(db, user, id);
  if (refresh && env.svc && t.wikiTicketId && !FINAL_STATES.includes(t.state) && user.role !== "admin_speed") {
    const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, t.partnerId));
    try {
      const snap = await env.svc.get(t.wikiTicketId, partner?.code ?? "");
      if (snap) {
        // Só as mensagens da Infra vêm de lá: as do parceiro e do sistema já estão no portal.
        for (const h of snap.historico.filter((x) => x.autor === "infra")) {
          await db.insert(ticketMessages).values({ ticketId: t.id, author: "infra", body: h.texto, sourceKey: hashOf(h.em, h.autor, h.texto), createdAt: new Date(h.em) }).onConflictDoNothing();
        }
        const done = snap.estado === "resolvido" || snap.estado === "cancelado";
        const [updated] = await db
          .update(tickets)
          .set({ state: snap.estado satisfies TicketRemoteState, resolvedAt: done ? (t.resolvedAt ?? new Date()) : null, updatedAt: new Date() })
          .where(eq(tickets.id, t.id))
          .returning();
        if (snap.estado !== t.state) {
          await recordAudit(db, { partnerId: t.partnerId, userId: null, action: `chamado.${snap.estado}`, entity: "ticket", entityId: t.id, data: { de: t.state } });
        }
        t = updated!;
      }
    } catch (e) {
      console.error("[chamado] leitura da Wiki falhou:", e instanceof Error ? e.message : e);
    }
  }
  const messages = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id)).orderBy(ticketMessages.createdAt);
  const [p] = user.role === "admin_speed" ? await db.select({ name: partners.name }).from(partners).where(eq(partners.id, t.partnerId)) : [];
  return {
    ...ticketView(t, p?.name ?? null),
    messages: messages.map((m) => ({ id: m.id, author: m.author as "parceiro" | "infra" | "sistema", body: m.body, createdAt: m.createdAt })),
    undelivered: t.state === "recebido",
  };
}

export async function addTicketMessage(db: Db, env: TicketEnv, user: SessionUser, id: string, body: string, opts: { ip?: string | null } = {}) {
  const t = await ownTicket(db, user, id);
  if (user.role === "admin_speed") throw new AppError(403, "sem_permissao", "A Speed responde pela fila da Infra, não por aqui.");
  if (FINAL_STATES.includes(t.state)) throw new AppError(409, "chamado_encerrado", "Esse chamado já foi encerrado.");
  const [m] = await db.insert(ticketMessages).values({ ticketId: t.id, author: "parceiro", body }).returning();
  await recordAudit(db, { partnerId: t.partnerId, userId: user.id, action: "chamado.mensagem", entity: "ticket", entityId: t.id, ip: opts.ip });
  if (env.svc && t.wikiTicketId) {
    const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, t.partnerId));
    try {
      await env.svc.addMessage(t.wikiTicketId, partner?.code ?? "", { idempotencyKey: m!.id, texto: body });
    } catch (e) {
      console.error("[chamado] mensagem não chegou à Wiki:", e instanceof Error ? e.message : e);
    }
  }
  return getTicket(db, env, user, id, false);
}

/** Reenvia à Wiki um chamado que ficou "recebido". */
export async function retryTicket(db: Db, env: TicketEnv, user: SessionUser, id: string) {
  const t = await ownTicket(db, user, id);
  if (t.state !== "recebido") throw new AppError(409, "sem_o_que_reenviar", "Esse chamado já foi entregue.");
  if (!env.svc) throw new AppError(503, "automacao_desligada", "A integração com a Infra ainda não está habilitada. O chamado continua guardado.");
  await deliver(db, env, t);
  return getTicket(db, env, user, id, false);
}

/** Chamado automático da trava de sinal, com as duas medições e a justificativa. Nunca derruba a decisão do técnico. */
export async function openSignalTicket(
  db: Db,
  env: TicketEnv,
  user: SessionUser,
  activation: { reservationId: string; snapshot: unknown },
  justification: string,
) {
  try {
    const snap = activation.snapshot as { sinal?: { ctoDbm: number; onuDbm: number; perdaDb: number; limiteDb: number } | null } | null;
    const s = snap?.sinal;
    const medicao = await db.select({ id: photos.id }).from(photos).where(and(eq(photos.reservationId, activation.reservationId), eq(photos.kind, "medicao"))).limit(2);
    const text = s
      ? `Trava de sinal: perda de ${s.perdaDb} dB (limite ${s.limiteDb} dB). Sinal na CTO ${s.ctoDbm} dBm, na ONU ${s.onuDbm} dBm. Justificativa do técnico: ${justification}`
      : `Trava de sinal. Justificativa do técnico: ${justification}`;
    await createTicket(db, env, user, { type: "trava_sinal", description: text.slice(0, 2000), reservationId: activation.reservationId, signalDbm: s?.ctoDbm ?? null, photoIds: medicao.map((m) => m.id) }, { origin: "sistema" });
  } catch (e) {
    console.error("[chamado] não foi possível abrir o chamado da trava de sinal:", e instanceof Error ? e.message : e);
  }
}
