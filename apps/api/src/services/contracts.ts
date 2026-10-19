import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { contractRequests, partners, plans, portReservations } from "../db/schema.js";
import { OPERATION_FINAL, type ContractAddress, type ContractService, type OperationState } from "../integrations/types.js";
import { OperationRefused } from "../integrations/wiki-actions.js";
import { AppError, isUniqueViolation } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import { clienteIncomplete } from "./installations.js";

type Row = typeof contractRequests.$inferSelect;

const REFUSAL_TEXT: Record<string, string> = {
  parceiro_sem_cadastro: "O parceiro ainda não está cadastrado no sistema da Speed com CNPJ e endereço completo. Fale com a Speed.",
  plano_nao_configurado: "Esse plano ainda não está configurado para criar contrato. Fale com a Speed.",
  login_de_outro_parceiro: "Esse cliente não pertence ao seu contrato.",
};

type Step = { nome: string; estado: string; motivo?: string | null };

/** Alguma etapa já concluída: o Voalle tem (ao menos parte de) um contrato desse pedido. */
const hasDoneStep = (r: Row) => ((r.steps as Step[] | null) ?? []).some((s) => s.estado === "concluida");

/**
 * Pedido que falhou ou foi recusado depois de criar algo no Voalle. Um novo pedido (chave nova) criaria um segundo
 * contrato e deixaria o primeiro órfão, então quem resolve é a Speed.
 */
const leftTraces = (r: Row) => (r.state === "falhou" || r.state === "abandonada") && hasDoneStep(r);

export const contractView = (r: Row) => ({
  id: r.id,
  reservationId: r.reservationId,
  state: r.state as OperationState | "abandonada",
  steps: (r.steps as Step[] | null) ?? [],
  contract: r.contract,
  login: r.login,
  reason: r.reason,
  /** Falhou depois de criar algo no Voalle: não dá para pedir de novo, a Speed precisa concluir ou cancelar. */
  needsSpeed: r.state === "falhou" && hasDoneStep(r),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

async function ownReservation(db: Db, user: SessionUser, id: string) {
  const [row] = await db
    .select()
    .from(portReservations)
    .where(user.role === "admin_speed" ? eq(portReservations.id, id) : and(eq(portReservations.id, id), eq(portReservations.partnerId, user.partnerId ?? "")));
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Reserva não encontrada.");
  return row;
}

async function latest(db: Db, reservationId: string): Promise<Row | null> {
  const [row] = await db.select().from(contractRequests).where(eq(contractRequests.reservationId, reservationId)).orderBy(desc(contractRequests.createdAt)).limit(1);
  return row ?? null;
}

/** Pede à Wiki a criação do contrato no Voalle. O número e o login PPPoE passam a nascer daqui, não mais digitados. */
export async function startContract(db: Db, svc: ContractService, user: SessionUser, reservationId: string, endereco: ContractAddress, opts: { ip?: string | null; idempotencyKey?: string } = {}) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro criam contrato.");
  const reservation = await ownReservation(db, user, reservationId);
  if (reservation.status !== "ativa") throw new AppError(409, "reserva_indisponivel", "Só uma reserva ativa pode ter contrato criado.");
  const faltando = clienteIncomplete(reservation);
  if (faltando.length) throw new AppError(422, "dados_cliente_obrigatorios", `Preencha os dados do cliente antes de criar o contrato: ${faltando.join(", ")}.`);

  const [partner] = await db.select({ code: partners.code, cnpj: partners.cnpj }).from(partners).where(eq(partners.id, reservation.partnerId));
  if (!partner?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código (ex.: JHV). A Speed precisa cadastrar.");
  const [plan] = await db.select().from(plans).where(eq(plans.id, reservation.planId!));
  if (!plan) throw new AppError(422, "plano_invalido", "Escolha um dos planos disponíveis.");

  // Nunca um segundo contrato por cima de um que falhou no meio: o primeiro ficaria órfão no Voalle.
  const previous = await latest(db, reservation.id);
  if (previous && leftTraces(previous)) {
    throw new AppError(409, "contrato_parcial", "O contrato desse cliente foi criado só em parte no sistema da Speed. A Speed precisa concluir ou cancelar antes de um novo pedido.");
  }

  const key = opts.idempotencyKey ?? randomUUID();
  let row: Row;
  try {
    await db.update(portReservations).set({ installAddress: endereco, updatedAt: new Date() }).where(eq(portReservations.id, reservation.id));
    const [created] = await db.insert(contractRequests).values({ partnerId: reservation.partnerId, reservationId: reservation.id, userId: user.id, idempotencyKey: key }).returning();
    row = created!;
    await recordAudit(db, { partnerId: reservation.partnerId, userId: user.id, action: "contrato.pedido", entity: "contract_request", entityId: row.id, ip: opts.ip, data: { reservationId: reservation.id, ctoId: reservation.ctoId, planoMbps: plan.speedMbps } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const [same] = await db.select().from(contractRequests).where(eq(contractRequests.idempotencyKey, key));
    if (!same || same.partnerId !== reservation.partnerId) throw new AppError(409, "contrato_ja_pedido", "Esse cliente já tem um contrato pedido.");
    row = same;
  }
  if (row.wikiOperationId) return contractView(row);
  return contractView(await send(db, svc, row, { code: partner.code, cnpj: partner.cnpj }, { speedMbps: plan.speedMbps, priceCents: plan.speedPriceCents }, reservation, endereco));
}

async function send(
  db: Db,
  svc: ContractService,
  row: Row,
  partner: { code: string; cnpj: string },
  plan: { speedMbps: number; priceCents: number },
  reservation: typeof portReservations.$inferSelect,
  endereco: ContractAddress,
): Promise<Row> {
  try {
    const started = await svc.create({
      idempotencyKey: row.idempotencyKey,
      reservaId: reservation.id,
      parceiroCnpj: partner.cnpj,
      partnerCode: partner.code,
      // O valor mensal é o que a Speed cobra do parceiro por esse plano (o preço de venda ao assinante é do parceiro).
      plano: { velocidadeMbps: plan.speedMbps, valorMensal: plan.priceCents / 100 },
      ctoId: reservation.ctoId,
      endereco,
      location: reservation.lat !== null && reservation.lng !== null ? { lat: reservation.lat, lng: reservation.lng } : null,
    });
    const [updated] = await db.update(contractRequests).set({ wikiOperationId: started.operacaoId, state: started.estado, updatedAt: new Date() }).where(eq(contractRequests.id, row.id)).returning();
    return updated!;
  } catch (e) {
    if (e instanceof OperationRefused) {
      await db.update(contractRequests).set({ state: "falhou", reason: e.code, updatedAt: new Date() }).where(eq(contractRequests.id, row.id));
      await recordAudit(db, { partnerId: row.partnerId, userId: row.userId, action: "contrato.recusado", entity: "contract_request", entityId: row.id, data: { motivo: e.code } });
      throw new AppError(409, e.code, REFUSAL_TEXT[e.code] ?? "A Speed recusou a criação do contrato.");
    }
    // Wiki fora do ar: o pedido fica guardado ("recebida") e repetir é seguro, com a mesma chave.
    console.error("[contrato] a Wiki não recebeu o pedido:", e instanceof Error ? e.message : e);
    return row;
  }
}

async function refresh(db: Db, svc: ContractService, row: Row): Promise<Row> {
  if (OPERATION_FINAL.includes(row.state as OperationState) || !row.wikiOperationId) return row;
  const [partner] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, row.partnerId));
  let snap;
  try {
    snap = await svc.get(row.wikiOperationId, partner?.code ?? "");
  } catch (e) {
    console.error("[contrato] leitura da Wiki falhou:", e instanceof Error ? e.message : e);
    return row;
  }
  if (!snap) throw new AppError(502, "operacao_perdida", "A Wiki não reconhece esse pedido de contrato. Fale com a Speed.");
  const result = snap.estado === "concluida" ? snap.resultado : null;
  // Defesa: o login que a Wiki devolve precisa terminar com o código do parceiro e começar com o contrato.
  if (snap.estado === "concluida" && (!result || result.login !== `${result.contrato}-${partner?.code}`)) {
    const [bad] = await db.update(contractRequests).set({ state: "falhou", reason: "resposta_inconsistente", steps: snap.etapas, updatedAt: new Date() }).where(eq(contractRequests.id, row.id)).returning();
    await recordAudit(db, { partnerId: row.partnerId, userId: row.userId, action: "contrato.inconsistente", entity: "contract_request", entityId: row.id });
    return bad!;
  }
  const [updated] = await db
    .update(contractRequests)
    .set({ state: snap.estado, steps: snap.etapas, contract: result?.contrato ?? null, login: result?.login ?? null, reason: snap.estado === "falhou" ? "falha_na_wiki" : null, updatedAt: new Date() })
    .where(eq(contractRequests.id, row.id))
    .returning();
  if (snap.estado !== row.state) {
    await recordAudit(db, { partnerId: row.partnerId, userId: row.userId, action: `contrato.${snap.estado}`, entity: "contract_request", entityId: row.id, data: { de: row.state, contrato: result?.contrato ?? null } });
  }
  if (result) {
    await db.update(portReservations).set({ contractNumber: result.contrato, updatedAt: new Date() }).where(eq(portReservations.id, row.reservationId));
  }
  return updated!;
}

/** Estado do contrato da reserva (consulta a Wiki enquanto estiver em andamento). null = ainda não pedido. */
export async function getContract(db: Db, svc: ContractService, user: SessionUser, reservationId: string) {
  const reservation = await ownReservation(db, user, reservationId);
  const row = await latest(db, reservation.id);
  if (!row) return null;
  return contractView(await refresh(db, svc, row));
}

/**
 * Repete (mesma chave) um pedido que não chegou à Wiki ou que parou no meio ("parcial"): a Wiki continua de onde parou e
 * nunca cria dois contratos para a mesma chave.
 */
export async function retryContract(db: Db, svc: ContractService, user: SessionUser, reservationId: string, opts: { ip?: string | null } = {}) {
  const reservation = await ownReservation(db, user, reservationId);
  const row = await latest(db, reservation.id);
  const waiting = !!row && ((row.state === "recebida" && !row.wikiOperationId) || row.state === "parcial");
  if (!row || !waiting) throw new AppError(409, "sem_o_que_repetir", "Esse pedido de contrato não está esperando repetição.");
  const endereco = reservation.installAddress as ContractAddress | null;
  if (!endereco) throw new AppError(422, "endereco_obrigatorio", "Informe o endereço de instalação.");
  const [partner] = await db.select({ code: partners.code, cnpj: partners.cnpj }).from(partners).where(eq(partners.id, reservation.partnerId));
  const [plan] = await db.select().from(plans).where(eq(plans.id, reservation.planId!));
  if (!partner?.code || !plan) throw new AppError(422, "dados_cliente_obrigatorios", "Faltam dados do parceiro ou do plano.");
  await recordAudit(db, { partnerId: row.partnerId, userId: user.id, action: "contrato.repetido", entity: "contract_request", entityId: row.id, ip: opts.ip });
  return contractView(await send(db, svc, row, { code: partner.code, cnpj: partner.cnpj }, { speedMbps: plan.speedMbps, priceCents: plan.speedPriceCents }, reservation, endereco));
}

/** Contrato já criado pela Wiki para a reserva, ou null. A ativação usa este número em vez de um digitado. */
export async function createdContract(db: Db, reservationId: string): Promise<{ contract: string; login: string } | null> {
  const [row] = await db.select().from(contractRequests).where(and(eq(contractRequests.reservationId, reservationId), eq(contractRequests.state, "concluida")));
  return row?.contract && row.login ? { contract: row.contract, login: row.login } : null;
}

// ── Para a Speed: contratos parados e abandono ───────────────────────────────

/** Tempos a partir dos quais um contrato parado vira alerta para a Speed. */
const STUCK_NOT_SENT_MIN = 5;
const STUCK_RUNNING_MIN = 15;
const STUCK_NO_ACTIVATION_DAYS = 7;

export type ContractIssueKind = "nao_enviado" | "parado" | "parcial" | "aguardando_equipe" | "falhou_no_meio" | "sem_ativacao";

export interface ContractIssue {
  reservationId: string;
  partnerName: string;
  contract: string | null;
  login: string | null;
  kind: ContractIssueKind;
  state: string;
  steps: Step[];
  reason: string | null;
  ageMinutes: number;
}

/**
 * Contratos que a Speed precisa olhar: pedido que não saiu, que não termina, que parou no meio, que espera a equipe,
 * que falhou depois de criar algo no Voalle, ou que foi criado e não virou instalação (reserva sem ativação por dias).
 * Um contrato criado e não aprovado não fatura, mas é lixo no Voalle se ninguém instala.
 */
export async function contractIssues(db: Db, now = new Date()): Promise<ContractIssue[]> {
  const rows = await db
    .select({ c: contractRequests, partnerName: partners.name, status: portReservations.status })
    .from(contractRequests)
    .innerJoin(partners, eq(partners.id, contractRequests.partnerId))
    .innerJoin(portReservations, eq(portReservations.id, contractRequests.reservationId));
  const out: ContractIssue[] = [];
  for (const { c, partnerName, status } of rows) {
    const age = Math.round((now.getTime() - c.updatedAt.getTime()) / 60_000);
    const base = { reservationId: c.reservationId, partnerName, contract: c.contract, login: c.login, state: c.state, steps: ((c.steps as Step[] | null) ?? []), reason: c.reason, ageMinutes: age };
    let kind: ContractIssueKind | null = null;
    if (c.state === "recebida" && !c.wikiOperationId && age >= STUCK_NOT_SENT_MIN) kind = "nao_enviado";
    else if (c.state === "executando" && age >= STUCK_RUNNING_MIN) kind = "parado";
    else if (c.state === "parcial") kind = "parcial";
    else if (c.state === "aguardando_equipe") kind = "aguardando_equipe";
    else if (c.state === "falhou" && hasDoneStep(c)) kind = "falhou_no_meio";
    else if (c.state === "concluida" && status === "ativa" && age >= STUCK_NO_ACTIVATION_DAYS * 24 * 60) kind = "sem_ativacao";
    if (kind) out.push({ ...base, kind });
  }
  return out.sort((a, b) => b.ageMinutes - a.ageMinutes);
}

/**
 * A Speed desiste de um contrato que não vai virar instalação: cancela a reserva (a vaga volta) e marca o pedido como
 * "abandonada". O contrato no Voalle precisa ser cancelado à mão pela equipe (o portal registra o número na auditoria
 * e o painel mostra "cancelar no Voalle") até a Wiki ter a rota de cancelar contrato não aprovado.
 */
export async function abandonContract(db: Db, admin: SessionUser, reservationId: string, reason: string, ip?: string | null) {
  const reservation = await ownReservation(db, admin, reservationId);
  if (reservation.status !== "ativa") {
    throw new AppError(409, "reserva_com_instalacao", "Esse cliente já tem ONU liberada ou foi encerrado: use o cancelamento do cliente.");
  }
  const row = await latest(db, reservation.id);
  if (!row || row.state === "abandonada") throw new AppError(404, "contrato_nao_encontrado", "Esse cliente não tem contrato pedido.");
  const now = new Date();
  const [updated] = await db.update(contractRequests).set({ state: "abandonada", reason: reason.trim(), updatedAt: now }).where(eq(contractRequests.id, row.id)).returning();
  await db
    .update(portReservations)
    .set({ status: "cancelada", cancelReason: `Contrato abandonado pela Speed: ${reason.trim()}`, cancelledBy: admin.id, updatedAt: now })
    .where(and(eq(portReservations.id, reservation.id), eq(portReservations.status, "ativa")));
  await recordAudit(db, {
    partnerId: row.partnerId,
    userId: admin.id,
    action: "contrato.abandonado",
    entity: "contract_request",
    entityId: row.id,
    ip,
    data: { contrato: row.contract, login: row.login, estadoAntes: row.state, etapas: (row.steps as Step[] | null) ?? [], motivo: reason.trim(), acao: "cancelar o contrato no Voalle" },
  });
  return contractView(updated!);
}
