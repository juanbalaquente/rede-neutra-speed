import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, partners, portReservations, settings } from "../db/schema.js";
import { ActivationRefused } from "../integrations/wiki-activation.js";
import {
  ACTIVATION_FINAL,
  type ActivationDecision,
  type ActivationService,
  type ActivationSnapshot,
  type ActivationState,
} from "../integrations/types.js";
import { AppError, isUniqueViolation } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import { clienteIncomplete } from "./installations.js";
import { createdContract } from "./contracts.js";
import { hasKind } from "./photos.js";
import { openSignalTicket, type TicketEnv } from "./tickets.js";

export const SIGNAL_LIMIT_KEY = "sinal.limite_db";
export const DEFAULT_SIGNAL_LIMIT_DB = 1.5;

export async function getSignalLimit(db: Db): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, SIGNAL_LIMIT_KEY));
  return typeof row?.value === "number" ? row.value : DEFAULT_SIGNAL_LIMIT_DB;
}

export async function setSignalLimit(db: Db, user: SessionUser, limitDb: number, ip?: string | null): Promise<number> {
  const before = await getSignalLimit(db);
  await db
    .insert(settings)
    .values({ key: SIGNAL_LIMIT_KEY, value: limitDb, updatedBy: user.id })
    .onConflictDoUpdate({ target: settings.key, set: { value: limitDb, updatedBy: user.id, updatedAt: new Date() } });
  await recordAudit(db, { partnerId: null, userId: user.id, action: "config.limite_sinal", entity: "setting", entityId: SIGNAL_LIMIT_KEY, ip, data: { before, after: limitDb } });
  return limitDb;
}

function requirePartner(user: SessionUser): string {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro liberam ONU.");
  return user.partnerId;
}

/** Reserva do próprio parceiro. De outro parceiro ou inexistente: 404, igual. */
async function ownReservation(db: Db, partnerId: string, id: string) {
  const [row] = await db
    .select()
    .from(portReservations)
    .where(and(eq(portReservations.id, id), eq(portReservations.partnerId, partnerId)));
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Reserva não encontrada.");
  return row;
}

async function ownActivation(db: Db, partnerId: string, id: string) {
  const [row] = await db
    .select()
    .from(activations)
    .where(and(eq(activations.id, id), eq(activations.partnerId, partnerId)));
  if (!row) throw new AppError(404, "ativacao_nao_encontrada", "Ativação não encontrada.");
  return row;
}

/** Código do parceiro (ex.: JHV): vai em todas as chamadas à Wiki. */
async function partnerCodeOf(db: Db, partnerId: string): Promise<string> {
  const [p] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, partnerId));
  if (!p?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código (ex.: JHV). A Speed precisa cadastrar.");
  return p.code;
}

/** A Wiki entregou a v2 desligada: enquanto a Speed não liga, responde 503 com um destes códigos. Vira aviso claro, não erro de rede. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ActivationRefused && e.status === 503) {
      throw new AppError(503, "ativacao_indisponivel", "A liberação de ONU ainda não foi liberada pela Speed. Tente mais tarde ou fale com a Speed.");
    }
    throw e;
  }
}

/** ONUs aguardando autorização na OLT que atende a CTO da reserva. */
export async function listPendingOnus(db: Db, svc: ActivationService, user: SessionUser, reservationId: string) {
  const partnerId = requirePartner(user);
  const reservation = await ownReservation(db, partnerId, reservationId);
  const code = await partnerCodeOf(db, partnerId);
  return guard(() => svc.listPendingOnus(reservation.ctoId, code));
}

export interface StartActivationInput {
  reservationId: string;
  serial: string;
  /** Número do contrato digitado. Com CONTRACT_MODE ligado é ignorado: vale o contrato criado pela Wiki. */
  contrato?: string;
  /** Sinal medido pelo técnico na CTO (dBm). Referência da trava de sinal. */
  sinalCtoDbm: number;
  /** Permite repetir o pedido sem duplicar (ex.: a rede caiu na resposta). */
  idempotencyKey?: string;
}

export async function startActivation(db: Db, svc: ActivationService, user: SessionUser, input: StartActivationInput, opts: { ip?: string | null; contractsEnabled?: boolean } = {}) {
  const partnerId = requirePartner(user);
  const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, partnerId));
  if (!partner?.code) {
    throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código (ex.: JHV). A Speed precisa cadastrar.");
  }
  const reservation = await ownReservation(db, partnerId, input.reservationId);
  if (reservation.status !== "ativa") {
    throw new AppError(409, "reserva_indisponivel", "Só uma reserva ativa pode ser ativada.");
  }

  // O contrato do planejamento: plano, visita e técnico antes de liberar a ONU.
  const faltando = clienteIncomplete(reservation);
  if (faltando.length) {
    throw new AppError(422, "dados_cliente_obrigatorios", `Preencha os dados do cliente antes de liberar a ONU: ${faltando.join(", ")}.`);
  }

  // A medição na CTO é a referência da trava de sinal: sem a foto dela, não há ativação.
  if (!(await hasKind(db, reservation.id, ["medicao"]))) {
    throw new AppError(422, "foto_medicao_obrigatoria", "Envie a foto da medição de sinal na CTO antes de liberar a ONU.");
  }

  // Com a criação automática ligada, o contrato e o login nascem do Voalle (via Wiki) e não podem ser digitados.
  let contrato = input.contrato ?? "";
  let pppLogin = `${contrato}-${partner.code}`;
  if (opts.contractsEnabled) {
    const made = await createdContract(db, reservation.id);
    if (!made) throw new AppError(409, "contrato_nao_criado", "Crie o contrato do cliente antes de liberar a ONU.");
    contrato = made.contract;
    pppLogin = made.login;
  } else if (!/^\d{1,12}$/.test(contrato)) {
    throw new AppError(400, "dados_invalidos", "Informe o número do contrato (só dígitos).");
  }
  const serial = input.serial.trim().toUpperCase();
  const key = input.idempotencyKey ?? randomUUID();
  const limiteDb = await getSignalLimit(db);

  let row: typeof activations.$inferSelect;
  try {
    const [created] = await db
      .insert(activations)
      .values({
        partnerId,
        userId: user.id,
        reservationId: reservation.id,
        idempotencyKey: key,
        ctoId: reservation.ctoId,
        serial,
        contract: contrato,
        pppLogin,
        sinalCtoDbm: input.sinalCtoDbm,
        limiteDb,
      })
      .returning();
    row = created!;
    await db.update(portReservations).set({ contractNumber: contrato, visitStatus: "em_execucao", updatedAt: new Date() }).where(eq(portReservations.id, reservation.id));
    await recordAudit(db, {
      partnerId,
      userId: user.id,
      action: "ativacao.pedida",
      entity: "activation",
      entityId: row.id,
      ip: opts.ip,
      data: { reservationId: reservation.id, ctoId: reservation.ctoId, serial, pppLogin, sinalCtoDbm: input.sinalCtoDbm, limiteDb },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Mesma chave: repetição do mesmo pedido. Reserva já com ativação aberta: conflito.
    const [same] = await db.select().from(activations).where(eq(activations.idempotencyKey, key));
    if (!same || same.partnerId !== partnerId) {
      throw new AppError(409, "ativacao_em_andamento", "Essa reserva já tem uma ativação em andamento.");
    }
    row = same;
  }

  if (row.wikiActivationId) return row;
  try {
    const started = await svc.start({
      partnerCode: partner.code,
      idempotencyKey: row.idempotencyKey,
      ctoId: row.ctoId,
      serial: row.serial,
      contrato: row.contract,
      pppLogin: row.pppLogin,
      alias: row.pppLogin,
      sinalCtoDbm: row.sinalCtoDbm,
      limiteDb: row.limiteDb,
    });
    const [updated] = await db
      .update(activations)
      .set({ wikiActivationId: started.ativacaoId, state: started.estado, updatedAt: new Date() })
      .where(eq(activations.id, row.id))
      .returning();
    return updated!;
  } catch (e) {
    if (e instanceof ActivationRefused && e.status === 503) {
      // Wiki com a v2 ainda desligada: o pedido fica guardado e pode ser repetido quando a Speed ligar.
      throw new AppError(503, "ativacao_indisponivel", "A liberação de ONU ainda não foi liberada pela Speed. Tente mais tarde ou fale com a Speed.");
    }
    if (e instanceof ActivationRefused || (e instanceof Error && (e as { code?: string }).code === "serial_nao_pendente")) {
      const code = e instanceof ActivationRefused ? e.code : "serial_nao_pendente";
      await db.update(activations).set({ state: "falhou", snapshot: { motivo: code }, updatedAt: new Date() }).where(eq(activations.id, row.id));
      await recordAudit(db, { partnerId, userId: user.id, action: "ativacao.recusada", entity: "activation", entityId: row.id, ip: opts.ip, data: { motivo: code } });
      throw new AppError(409, code, ACTIVATION_REFUSAL_TEXT[code] ?? "A Speed recusou a ativação.");
    }
    // Falha de rede: a ativação fica "recebida" e o mesmo pedido (mesma chave) pode ser repetido sem duplicar.
    throw e;
  }
}

const ACTIVATION_REFUSAL_TEXT: Record<string, string> = {
  serial_nao_pendente: "Essa ONU não está na lista de pendentes. Confira a serial na etiqueta.",
  porta_ocupada: "A porta da CTO já está ocupada. A Speed precisa conferir.",
  serial_em_ativacao: "Essa ONU já está em outra ativação aberta. Termine ou cancele a anterior.",
  login_fora_do_padrao: "O login não segue o padrão contrato-código do provedor. A Speed precisa conferir o cadastro.",
};

/** Aplica a leitura da Wiki à ativação; online converte a reserva. */
async function applySnapshot(db: Db, row: typeof activations.$inferSelect, snap: ActivationSnapshot, userId: string | null) {
  const [updated] = await db
    .update(activations)
    .set({ state: snap.estado, snapshot: snap, updatedAt: new Date() })
    .where(eq(activations.id, row.id))
    .returning();
  if (snap.estado !== row.state) {
    await recordAudit(db, { partnerId: row.partnerId, userId, action: `ativacao.${snap.estado}`, entity: "activation", entityId: row.id, data: { de: row.state, motivo: snap.motivo } });
  }
  if (snap.estado === "online") {
    await db
      .update(portReservations)
      .set({ status: "convertida", updatedAt: new Date() })
      .where(and(eq(portReservations.id, row.reservationId), eq(portReservations.status, "ativa")));
  }
  // Cancelada ou falhou antes de provisionar: a vaga reservada volta a valer para novo pedido (o índice só barra as abertas).
  return updated!;
}

/**
 * Estados em que o portal para de consultar a Wiki. A falha de configuração continua sendo lida: a ONU fica autorizada,
 * o NOC resolve pela Wiki e a ativação pode virar online depois (29 out 2026, 33766-JHV).
 */
const STOP_SYNC: readonly ActivationState[] = ACTIVATION_FINAL.filter((s) => s !== "falha_provisionamento");

/** Estado atual da ativação, consultando a Wiki enquanto não terminou. */
export async function getActivation(db: Db, svc: ActivationService, user: SessionUser, id: string) {
  const row = await ownActivation(db, requirePartner(user), id);
  if (STOP_SYNC.includes(row.state as ActivationState) || !row.wikiActivationId) return row;
  const snap = await guard(async () => svc.get(row.wikiActivationId!, await partnerCodeOf(db, row.partnerId)));
  if (!snap) throw new AppError(502, "ativacao_perdida", "A Wiki não reconhece essa ativação. Fale com a Speed.");
  return applySnapshot(db, row, snap, user.id);
}

export async function decideActivation(db: Db, svc: ActivationService, user: SessionUser, id: string, decision: ActivationDecision, opts: { ip?: string | null; tickets?: TicketEnv } = {}) {
  const row = await ownActivation(db, requirePartner(user), id);
  if (row.state !== "aguardando_decisao" || !row.wikiActivationId) {
    throw new AppError(409, "sem_decisao_pendente", "Essa ativação não está esperando decisão.");
  }
  if (decision.acao === "prosseguir" && decision.justificativa.trim().length < 10) {
    throw new AppError(422, "justificativa_obrigatoria", "Explique a justificativa (mínimo 10 caracteres).");
  }
  const snap = await guard(async () => svc.decide(row.wikiActivationId!, await partnerCodeOf(db, row.partnerId), decision));
  await recordAudit(db, {
    partnerId: row.partnerId,
    userId: user.id,
    action: "ativacao.decisao",
    entity: "activation",
    entityId: row.id,
    ip: opts.ip,
    data: { acao: decision.acao, justificativa: decision.acao === "prosseguir" ? decision.justificativa : undefined, sinal: (row.snapshot as ActivationSnapshot | null)?.sinal ?? null },
  });
  // Prosseguir com a trava de sinal abre o chamado da Infra (aparece na lista do parceiro, marcado como automático).
  if (decision.acao === "prosseguir" && opts.tickets) await openSignalTicket(db, opts.tickets, user, row, decision.justificativa.trim());
  return applySnapshot(db, row, snap, user.id);
}

/**
 * Nova tentativa depois de `falha_provisionamento` (Wiki, 29 out 2026): o mesmo pedido com chave nova reabre a ativação
 * na Wiki (mesmo ativacaoId, volta em `provisionando`, sem repetir o reset de fábrica).
 */
export async function retryActivation(db: Db, svc: ActivationService, user: SessionUser, id: string, opts: { ip?: string | null } = {}) {
  const row = await ownActivation(db, requirePartner(user), id);
  if (row.state !== "falha_provisionamento") {
    throw new AppError(409, "sem_nova_tentativa", "Só a ativação com falha na configuração pode ser tentada de novo.");
  }
  const partnerCode = await partnerCodeOf(db, row.partnerId);
  const key = randomUUID();
  const started = await guard(async () => {
    try {
      return await svc.start({
        partnerCode,
        idempotencyKey: key,
        ctoId: row.ctoId,
        serial: row.serial,
        contrato: row.contract,
        pppLogin: row.pppLogin,
        alias: row.pppLogin,
        sinalCtoDbm: row.sinalCtoDbm,
        limiteDb: row.limiteDb,
      });
    } catch (e) {
      if (e instanceof ActivationRefused && e.status !== 503) throw new AppError(409, e.code, ACTIVATION_REFUSAL_TEXT[e.code] ?? "A Speed recusou a nova tentativa.");
      throw e;
    }
  });
  const [updated] = await db
    .update(activations)
    .set({ idempotencyKey: key, wikiActivationId: started.ativacaoId, state: started.estado, snapshot: { ...(row.snapshot as object | null), motivo: "nova_tentativa_pelo_portal" }, updatedAt: new Date() })
    .where(eq(activations.id, row.id))
    .returning();
  await recordAudit(db, { partnerId: row.partnerId, userId: user.id, action: "ativacao.nova_tentativa", entity: "activation", entityId: row.id, ip: opts.ip, data: { de: row.state, para: started.estado } });
  return updated!;
}

export async function listActivations(db: Db, user: SessionUser) {
  const partnerId = requirePartner(user);
  return db.select().from(activations).where(eq(activations.partnerId, partnerId)).orderBy(desc(activations.createdAt)).limit(100);
}
