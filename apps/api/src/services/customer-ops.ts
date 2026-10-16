import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, customerOperations, partners, portReservations, settings } from "../db/schema.js";
import { OPERATION_FINAL, type CustomerActions, type OperationSnapshot, type OperationState, type OperationType } from "../integrations/types.js";
import { OperationRefused } from "../integrations/wiki-actions.js";
import { AppError, isUniqueViolation } from "../lib/errors.js";
import { recordAudit } from "./audit.js";

type Row = typeof customerOperations.$inferSelect;

const REFUSAL_TEXT: Record<string, string> = {
  fatura_em_aberto: "O cliente tem fatura em aberto. Quite antes de cancelar.",
  login_de_outro_parceiro: "Esse cliente não pertence ao seu contrato.",
};

/** Dados da operação para a tela. Nunca carrega segredo, senha nem saída crua de equipamento. */
export const operationView = (o: Row) => ({
  decisionReason: o.decisionReason,
  id: o.id,
  reservationId: o.reservationId,
  type: o.type as OperationType,
  login: o.login,
  reason: o.reason,
  state: o.state as OperationState,
  steps: (o.steps as OperationSnapshot["etapas"] | null) ?? [],
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

async function ownReservation(db: Db, user: SessionUser, id: string) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro operam clientes.");
  const [row] = await db
    .select()
    .from(portReservations)
    .where(and(eq(portReservations.id, id), eq(portReservations.partnerId, user.partnerId)));
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Cliente não encontrado.");
  return row;
}

async function ownOperation(db: Db, user: SessionUser, id: string) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro operam clientes.");
  const [row] = await db
    .select()
    .from(customerOperations)
    .where(and(eq(customerOperations.id, id), eq(customerOperations.partnerId, user.partnerId)));
  if (!row) throw new AppError(404, "operacao_nao_encontrada", "Operação não encontrada.");
  return row;
}

/** Login PPPoE do cliente: o da ativação que o colocou no ar. */
async function loginOf(db: Db, reservationId: string): Promise<string> {
  const [a] = await db
    .select({ login: activations.pppLogin })
    .from(activations)
    .where(and(eq(activations.reservationId, reservationId), eq(activations.state, "online")))
    .orderBy(desc(activations.createdAt))
    .limit(1);
  if (!a) throw new AppError(409, "cliente_sem_login", "Esse cliente ainda não tem ONU liberada.");
  return a.login;
}

/** Regras de cada operação sobre o estado atual do cliente. Devolve a mensagem de recusa, ou null se pode. */
function refuse(type: OperationType, r: typeof portReservations.$inferSelect): string | null {
  if (r.status !== "convertida" || !r.osClosedAt) return "Só cliente com a O.S. fechada pode receber essa operação.";
  if (r.customerStatus === "cancelado") return "Esse cliente já foi cancelado.";
  if (type === "bloqueio" && r.customerStatus === "bloqueado") return "Esse cliente já está bloqueado.";
  if (type === "desbloqueio" && r.customerStatus !== "bloqueado") return "Esse cliente não está bloqueado.";
  return null;
}

export async function startOperation(
  db: Db,
  svc: CustomerActions,
  user: SessionUser,
  reservationId: string,
  input: { type: OperationType; reason?: string | null; idempotencyKey?: string },
  opts: { ip?: string | null } = {},
) {
  const reservation = await ownReservation(db, user, reservationId);
  // Cancelar é decisão do supervisor; bloquear, desbloquear e reiniciar o atendente também faz (planejamento, perfis).
  if (input.type === "cancelamento" && user.role !== "supervisor") {
    throw new AppError(403, "sem_permissao", "Só o supervisor cancela um cliente.");
  }
  if (input.type === "cancelamento" && !(input.reason ?? "").trim()) {
    throw new AppError(422, "motivo_obrigatorio", "Informe o motivo do cancelamento.");
  }
  const why = refuse(input.type, reservation);
  if (why) throw new AppError(409, "operacao_indisponivel", why);

  const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, reservation.partnerId));
  if (!partner?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código cadastrado.");
  const login = await loginOf(db, reservation.id);
  const key = input.idempotencyKey ?? randomUUID();
  // A Speed pode exigir a aprovação dela para certos tipos: a operação espera, sem chegar à Wiki, até ser aprovada.
  const needsApproval = (await getApprovalTypes(db)).includes(input.type);

  let row: Row;
  try {
    const [created] = await db
      .insert(customerOperations)
      .values({ partnerId: reservation.partnerId, reservationId: reservation.id, userId: user.id, type: input.type, login, reason: input.reason?.trim() || null, idempotencyKey: key, state: needsApproval ? "aguardando_aprovacao" : "recebida" })
      .returning();
    row = created!;
    await recordAudit(db, { partnerId: reservation.partnerId, userId: user.id, action: `cliente.${input.type}_pedido`, entity: "customer_operation", entityId: row.id, ip: opts.ip, data: { login, contract: reservation.contractNumber, motivo: row.reason } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Mesma chave: repetição do mesmo pedido. Outra operação aberta do mesmo tipo: conflito.
    const [same] = await db.select().from(customerOperations).where(eq(customerOperations.idempotencyKey, key));
    if (!same || same.partnerId !== reservation.partnerId) {
      throw new AppError(409, "operacao_em_andamento", "Já existe uma operação desse tipo em andamento para esse cliente.");
    }
    row = same;
  }
  if (row.wikiOperationId || row.state === "aguardando_aprovacao") return row;
  return send(db, svc, row, partner.code);
}

/** Envia (ou reenvia, com a mesma chave) o pedido à Wiki. Falha de rede deixa a operação "recebida", e repetir é seguro. */
async function send(db: Db, svc: CustomerActions, row: Row, partnerCode: string): Promise<Row> {
  try {
    const started = await svc.start({ idempotencyKey: row.idempotencyKey, tipo: row.type as OperationType, login: row.login, partnerCode, motivo: row.reason });
    const [updated] = await db
      .update(customerOperations)
      .set({ wikiOperationId: started.operacaoId, state: started.estado, updatedAt: new Date() })
      .where(eq(customerOperations.id, row.id))
      .returning();
    return updated!;
  } catch (e) {
    if (e instanceof OperationRefused) {
      await db.update(customerOperations).set({ state: "falhou", steps: [{ nome: "pedido", estado: "falhou", motivo: e.code }], updatedAt: new Date() }).where(eq(customerOperations.id, row.id));
      await recordAudit(db, { partnerId: row.partnerId, userId: row.userId, action: "cliente.operacao_recusada", entity: "customer_operation", entityId: row.id, data: { motivo: e.code } });
      throw new AppError(409, e.code, REFUSAL_TEXT[e.code] ?? "A Speed recusou a operação.");
    }
    throw e;
  }
}

/** O que muda no portal quando a Wiki confirma a operação. Idempotente. */
async function applyOutcome(db: Db, row: Row) {
  const now = new Date();
  if (row.type === "bloqueio") {
    await db.update(portReservations).set({ customerStatus: "bloqueado", updatedAt: now }).where(and(eq(portReservations.id, row.reservationId), eq(portReservations.customerStatus, "ativo")));
  } else if (row.type === "desbloqueio") {
    await db.update(portReservations).set({ customerStatus: "ativo", updatedAt: now }).where(and(eq(portReservations.id, row.reservationId), eq(portReservations.customerStatus, "bloqueado")));
  } else if (row.type === "cancelamento") {
    // A vaga volta: a contagem de reservas vivas só considera ativa e convertida.
    await db
      .update(portReservations)
      .set({ status: "cancelada", customerStatus: "cancelado", cancelReason: row.reason, cancelledBy: row.userId, updatedAt: now })
      .where(and(eq(portReservations.id, row.reservationId), eq(portReservations.status, "convertida")));
  }
}

export async function refreshOperation(db: Db, svc: CustomerActions, user: SessionUser, id: string) {
  const row = await ownOperation(db, user, id);
  if (OPERATION_FINAL.includes(row.state as OperationState) || !row.wikiOperationId) return row;
  const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, row.partnerId));
  const snap = await svc.get(row.wikiOperationId, partner?.code ?? "");
  if (!snap) throw new AppError(502, "operacao_perdida", "A Wiki não reconhece essa operação. Fale com a Speed.");
  const [updated] = await db
    .update(customerOperations)
    .set({ state: snap.estado, steps: snap.etapas, updatedAt: new Date() })
    .where(eq(customerOperations.id, row.id))
    .returning();
  if (snap.estado !== row.state) {
    await recordAudit(db, { partnerId: row.partnerId, userId: user.id, action: `cliente.${row.type}_${snap.estado}`, entity: "customer_operation", entityId: row.id, data: { de: row.state, login: row.login } });
  }
  if (snap.estado === "concluida") await applyOutcome(db, updated!);
  return updated!;
}

/** Operação parcial (ou que não chegou à Wiki): repete com a mesma chave, e a Wiki continua de onde parou. */
export async function retryOperation(db: Db, svc: CustomerActions, user: SessionUser, id: string, opts: { ip?: string | null } = {}) {
  const row = await ownOperation(db, user, id);
  if (row.state !== "parcial" && !(row.state === "recebida" && !row.wikiOperationId)) {
    throw new AppError(409, "sem_o_que_repetir", "Essa operação não está esperando repetição.");
  }
  const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, row.partnerId));
  await recordAudit(db, { partnerId: row.partnerId, userId: user.id, action: "cliente.operacao_repetida", entity: "customer_operation", entityId: row.id, ip: opts.ip });
  return send(db, svc, row, partner?.code ?? "");
}

export async function listOperations(db: Db, user: SessionUser, reservationId: string) {
  const reservation = await ownReservation(db, user, reservationId);
  const rows = await db.select().from(customerOperations).where(eq(customerOperations.reservationId, reservation.id)).orderBy(desc(customerOperations.createdAt)).limit(30);
  return rows.map(operationView);
}

export async function getOperation(db: Db, svc: CustomerActions, user: SessionUser, id: string) {
  return operationView(await refreshOperation(db, svc, user, id));
}

// ── Aprovação da Speed (planejamento: o administrador "aprova ou recusa operações") ──────────────────────────────

export const APPROVAL_KEY = "aprovacao.operacoes";
export const OPERATION_TYPES: OperationType[] = ["bloqueio", "desbloqueio", "reinicio", "cancelamento"];

/** Tipos de operação que só seguem para a Wiki depois que a Speed aprova. Padrão: nenhum. */
export async function getApprovalTypes(db: Db): Promise<OperationType[]> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, APPROVAL_KEY));
  const saved = Array.isArray(row?.value) ? (row!.value as unknown[]) : [];
  return OPERATION_TYPES.filter((t) => saved.includes(t));
}

export async function setApprovalTypes(db: Db, user: SessionUser, types: OperationType[], ip?: string | null) {
  const before = await getApprovalTypes(db);
  const next = OPERATION_TYPES.filter((t) => types.includes(t));
  await db
    .insert(settings)
    .values({ key: APPROVAL_KEY, value: next, updatedBy: user.id })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedBy: user.id, updatedAt: new Date() } });
  await recordAudit(db, { partnerId: null, userId: user.id, action: "config.aprovacao", entity: "setting", entityId: APPROVAL_KEY, ip, data: { before, after: next } });
  return next;
}

/** Operações esperando a Speed, de todos os parceiros (as mais antigas primeiro). */
export async function listPendingApprovals(db: Db) {
  const rows = await db
    .select({ o: customerOperations, partnerName: partners.name, contract: portReservations.contractNumber, nickname: portReservations.nickname })
    .from(customerOperations)
    .innerJoin(partners, eq(partners.id, customerOperations.partnerId))
    .innerJoin(portReservations, eq(portReservations.id, customerOperations.reservationId))
    .where(eq(customerOperations.state, "aguardando_aprovacao"))
    .orderBy(customerOperations.createdAt);
  return rows.map((r) => ({ ...operationView(r.o), partnerName: r.partnerName, contract: r.contract, nickname: r.nickname }));
}

async function pendingOperation(db: Db, id: string): Promise<Row> {
  const [row] = await db.select().from(customerOperations).where(eq(customerOperations.id, id));
  if (!row) throw new AppError(404, "operacao_nao_encontrada", "Operação não encontrada.");
  if (row.state !== "aguardando_aprovacao") throw new AppError(409, "sem_o_que_decidir", "Essa operação não está esperando aprovação.");
  return row;
}

/** A Speed aprova: a operação segue para a Wiki com a mesma chave. A decisão fica na auditoria. */
export async function approveOperation(db: Db, svc: CustomerActions, admin: SessionUser, id: string, ip?: string | null) {
  const row = await pendingOperation(db, id);
  const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, row.partnerId));
  if (!partner?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código cadastrado.");
  const [approved] = await db
    .update(customerOperations)
    .set({ state: "recebida", decidedBy: admin.id, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(customerOperations.id, id), eq(customerOperations.state, "aguardando_aprovacao")))
    .returning();
  if (!approved) throw new AppError(409, "sem_o_que_decidir", "Essa operação não está esperando aprovação.");
  await recordAudit(db, { partnerId: row.partnerId, userId: admin.id, action: "cliente.operacao_aprovada", entity: "customer_operation", entityId: row.id, ip, data: { tipo: row.type, login: row.login } });
  return operationView(await send(db, svc, approved, partner.code));
}

export async function refuseOperation(db: Db, admin: SessionUser, id: string, reason: string, ip?: string | null) {
  const row = await pendingOperation(db, id);
  const [refused] = await db
    .update(customerOperations)
    .set({ state: "recusada", decidedBy: admin.id, decidedAt: new Date(), decisionReason: reason.trim(), updatedAt: new Date() })
    .where(and(eq(customerOperations.id, id), eq(customerOperations.state, "aguardando_aprovacao")))
    .returning();
  if (!refused) throw new AppError(409, "sem_o_que_decidir", "Essa operação não está esperando aprovação.");
  await recordAudit(db, { partnerId: row.partnerId, userId: admin.id, action: "cliente.operacao_recusada_pela_speed", entity: "customer_operation", entityId: row.id, ip, data: { tipo: row.type, login: row.login, motivo: reason.trim() } });
  return operationView(refused);
}

// ── Em lote (planejamento: as automações rodam "a partir da tela do cliente ou em lote") ───────────────────────

export const BATCH_MAX = 50;
export type BatchType = "bloqueio" | "desbloqueio" | "reinicio";

export interface BatchResult {
  reservationId: string;
  ok: boolean;
  operationId: string | null;
  state: string | null;
  /** Texto curto para o parceiro quando o cliente foi pulado ou falhou. */
  error: string | null;
}

/**
 * Bloqueia, desbloqueia ou reinicia vários clientes de uma vez. Cada cliente vira uma operação normal (com as mesmas regras,
 * idempotência e aprovação da Speed); um que não pode ser feito é pulado com o motivo, sem barrar os outros.
 * Cancelamento fica de fora de propósito: encerra contrato e devolve a vaga, e deve ser decidido cliente a cliente.
 */
export async function startBatch(
  db: Db,
  svc: CustomerActions,
  user: SessionUser,
  input: { type: BatchType; reservationIds: string[]; reason?: string | null },
  opts: { ip?: string | null } = {},
): Promise<BatchResult[]> {
  const ids = [...new Set(input.reservationIds)];
  if (ids.length === 0 || ids.length > BATCH_MAX) throw new AppError(400, "dados_invalidos", `Escolha de 1 a ${BATCH_MAX} clientes.`);
  const results: BatchResult[] = [];
  for (const reservationId of ids) {
    try {
      const op = await startOperation(db, svc, user, reservationId, { type: input.type, reason: input.reason }, { ip: opts.ip });
      results.push({ reservationId, ok: true, operationId: op.id, state: op.state, error: null });
    } catch (e) {
      // Recusa de regra de negócio (já bloqueado, sem ONU, outro parceiro...) é resultado, não erro do lote.
      if (e instanceof AppError) results.push({ reservationId, ok: false, operationId: null, state: null, error: e.status === 404 ? "Cliente não encontrado." : e.message });
      else throw e;
    }
  }
  await recordAudit(db, {
    partnerId: user.partnerId,
    userId: user.id,
    action: "cliente.lote",
    entity: "customer_operation",
    ip: opts.ip,
    data: { tipo: input.type, pedidos: ids.length, feitos: results.filter((r) => r.ok).length, pulados: results.filter((r) => !r.ok).length },
  });
  return results;
}
