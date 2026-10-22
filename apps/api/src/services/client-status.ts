import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, partners, portReservations } from "../db/schema.js";
import type { ClientStatus, ClientStatusService, ClientSummary, SignalSeries } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";

/** Idade a partir da qual o portal avisa que o dado está velho (contrato v3: 15 min fibra, 30 min PPPoE em snapshot). */
export const FIBRA_STALE_MS = 15 * 60_000;
export const PPPOE_STALE_MS = 30 * 60_000;

const SIGNAL_DAYS = [7, 30, 90];

function requireSvc(svc: ClientStatusService | undefined): ClientStatusService {
  if (!svc) throw new AppError(503, "status_desligado", "O status do cliente na rede ainda não está habilitado.");
  return svc;
}

/** Reserva do parceiro da sessão (ou qualquer uma, para a Speed). De outro parceiro ou inexistente: 404, igual. */
async function reservationOf(db: Db, user: SessionUser, id: string) {
  const [row] = await db
    .select()
    .from(portReservations)
    .where(user.role === "admin_speed" ? eq(portReservations.id, id) : and(eq(portReservations.id, id), eq(portReservations.partnerId, user.partnerId ?? "")));
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Cliente não encontrado.");
  return row;
}

async function loginAndCode(db: Db, reservation: { id: string; partnerId: string }) {
  const [a] = await db
    .select({ login: activations.pppLogin, sinalCtoDbm: activations.sinalCtoDbm, limiteDb: activations.limiteDb })
    .from(activations)
    .where(and(eq(activations.reservationId, reservation.id), eq(activations.state, "online")))
    .orderBy(desc(activations.createdAt))
    .limit(1);
  if (!a) throw new AppError(409, "cliente_sem_login", "Esse cliente ainda não tem ONU liberada.");
  const [p] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, reservation.partnerId));
  if (!p?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código cadastrado.");
  return { ...a, code: p.code };
}

/** Falha da Wiki vira 502 com texto próprio; o resto da tela do cliente continua funcionando. */
async function remote<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[status] ${what} falhou:`, e instanceof Error ? e.message : e);
    throw new AppError(502, "status_indisponivel", "Não foi possível consultar o estado do cliente agora. Tente de novo em instantes.");
  }
}

const ageMs = (iso: string | null, now: number) => (iso ? now - new Date(iso).getTime() : null);

export async function getClientStatus(db: Db, svc: ClientStatusService | undefined, user: SessionUser, reservationId: string, opts: { fresh?: boolean; now?: number } = {}) {
  const service = requireSvc(svc);
  const reservation = await reservationOf(db, user, reservationId);
  const { login, code, sinalCtoDbm, limiteDb } = await loginAndCode(db, reservation);
  const status = await remote("status", () => service.status(login, code, { fresh: opts.fresh }));
  if (!status) throw new AppError(404, "cliente_nao_encontrado_na_rede", "A rede ainda não conhece esse login. A ONU pode não ter sido autorizada.");
  const now = opts.now ?? Date.now();
  const fibraAge = ageMs(status.fibra.atualizadoEm, now);
  const pppAge = ageMs(status.autenticacao.atualizadoEm, now);
  return {
    status,
    /** Dado velho (ou sem data): a tela avisa em vez de mostrar como se fosse de agora. */
    fibraVelha: fibraAge === null || fibraAge > FIBRA_STALE_MS,
    pppoeVelho: pppAge === null || pppAge > PPPOE_STALE_MS,
    referencia: { sinalCtoDbm, limiteDb, minimoDbm: Number((sinalCtoDbm - limiteDb).toFixed(2)) },
  };
}

export async function getClientSignal(db: Db, svc: ClientStatusService | undefined, user: SessionUser, reservationId: string, days: number) {
  const service = requireSvc(svc);
  if (!SIGNAL_DAYS.includes(days)) throw new AppError(400, "periodo_invalido", "Escolha 7, 30 ou 90 dias.");
  const reservation = await reservationOf(db, user, reservationId);
  const { login, code, sinalCtoDbm, limiteDb } = await loginAndCode(db, reservation);
  const series: SignalSeries | null = await remote("sinal", () => service.signal(login, code, days));
  if (!series) throw new AppError(404, "cliente_nao_encontrado_na_rede", "A rede ainda não conhece esse login.");
  return { series, referencia: { sinalCtoDbm, limiteDb, minimoDbm: Number((sinalCtoDbm - limiteDb).toFixed(2)) } };
}

export interface FleetAlarm {
  reservationId: string;
  contract: string | null;
  nickname: string | null;
  login: string;
  motivo: "fibra_loss" | "fibra_offline" | "sem_energia" | "pppoe_caido";
}

/** Fibra online e PPPoE conectado lado a lado, sobre as portas ativas do parceiro (snapshot da Wiki, nunca ao vivo). */
export async function getFleetStatus(db: Db, svc: ClientStatusService | undefined, user: SessionUser) {
  const service = requireSvc(svc);
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Painel disponível só para o parceiro.");
  const [p] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, user.partnerId));
  if (!p?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código cadastrado.");

  const rows = await db
    .select({ id: portReservations.id, contract: portReservations.contractNumber, nickname: portReservations.nickname, customerStatus: portReservations.customerStatus, login: activations.pppLogin })
    .from(portReservations)
    .innerJoin(activations, and(eq(activations.reservationId, portReservations.id), eq(activations.state, "online")))
    .where(and(eq(portReservations.partnerId, user.partnerId), eq(portReservations.status, "convertida"), isNotNull(portReservations.osClosedAt), ne(portReservations.customerStatus, "cancelado")));
  const byLogin = new Map(rows.map((r) => [r.login, r]));
  const logins = [...byLogin.keys()];
  const empty = { total: 0, fibraOnline: 0, pppoeConectado: 0, loss: 0, offline: 0, bloqueados: 0, semDados: 0, alarmes: [] as FleetAlarm[], atualizadoEm: null as string | null };
  if (!logins.length) return empty;

  const summary: ClientSummary[] = await remote("lote", () => service.summary(logins, p.code!));
  const out = { ...empty, total: logins.length };
  let oldest: number | null = null;
  const seen = new Set<string>();
  for (const s of summary) {
    const r = byLogin.get(s.login);
    if (!r || seen.has(s.login)) continue; // a Wiki só responde pelo que o portal perguntou
    seen.add(s.login);
    if (s.fibra === "desconhecido" && s.autenticacao === "desconhecido") out.semDados++;
    if (s.fibra === "online") out.fibraOnline++;
    if (s.autenticacao === "conectado") out.pppoeConectado++;
    if (s.fibra === "loss") out.loss++;
    if (s.fibra === "offline" || s.fibra === "sem_energia") out.offline++;
    // Bloqueado (contrato no Voalle, bloqueio da Speed na ONU ou situação no portal) é esperado: sem PPPoE e com fibra caindo, não vira alarme.
    const blocked = s.contrato === "bloqueado" || s.bloqueio?.ativo === true || r.customerStatus === "bloqueado";
    if (blocked) out.bloqueados++;
    const motivo: FleetAlarm["motivo"] | null = blocked ? null : s.fibra === "loss" ? "fibra_loss" : s.fibra === "sem_energia" ? "sem_energia" : s.fibra === "offline" ? "fibra_offline" : s.fibra === "online" && s.autenticacao === "desconectado" ? "pppoe_caido" : null;
    if (motivo) out.alarmes.push({ reservationId: r.id, contract: r.contract, nickname: r.nickname, login: s.login, motivo });
    for (const at of [s.fibraEm, s.autenticacaoEm]) if (at && (oldest === null || new Date(at).getTime() < oldest)) oldest = new Date(at).getTime();
  }
  out.semDados += logins.length - seen.size;
  out.atualizadoEm = oldest === null ? null : new Date(oldest).toISOString();
  return out;
}

export type { ClientStatus };
