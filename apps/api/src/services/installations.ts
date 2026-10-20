import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, contractRequests, partners, photos, plans, portReservations, settings, type PhotoKind } from "../db/schema.js";
import type { ContractAddress } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";

/** Fotos do checklist do planejamento (etapa 6) mais a medição na CTO, exigida antes de ativar. */
export const OS_REQUIRED_KINDS: readonly PhotoKind[] = ["medicao", "cto_aberta", "etiqueta_porta", "medicao_onu", "sobra_fibra", "onu_instalada"];

export const OS_PHOTOS_KEY = "os.fotos_obrigatorias";

export async function getOsPhotosRequired(db: Db): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, OS_PHOTOS_KEY));
  return typeof row?.value === "boolean" ? row.value : true;
}

export async function setOsPhotosRequired(db: Db, user: SessionUser, required: boolean, ip?: string | null) {
  const before = await getOsPhotosRequired(db);
  await db
    .insert(settings)
    .values({ key: OS_PHOTOS_KEY, value: required, updatedBy: user.id })
    .onConflictDoUpdate({ target: settings.key, set: { value: required, updatedBy: user.id, updatedAt: new Date() } });
  await recordAudit(db, { partnerId: null, userId: user.id, action: "config.fotos_os", entity: "setting", entityId: OS_PHOTOS_KEY, ip, data: { before, after: required } });
  return required;
}

/** Dados que o técnico confirma ao fechar a O.S. (planejamento, etapa 6). */
export interface OsInput {
  /** Texto livre e opcional: a reserva é por vaga, a Wiki não vincula porta. */
  porta?: string | null;
  sinalFinalDbm: number;
  modeloOnu: string;
  serialOnu: string;
  observacao?: string | null;
  /** Obrigatória quando o sinal final fica abaixo do mínimo aceitável (sinal da CTO menos o limite da ativação). */
  justificativaSinal?: string | null;
}

/** Referência da trava de sinal da ativação concluída: o menor sinal aceitável na ONU. */
export async function signalReference(db: Db, reservationId: string): Promise<{ sinalCtoDbm: number; limiteDb: number; minimoDbm: number; onuDbm: number | null } | null> {
  const [a] = await db
    .select({ sinalCtoDbm: activations.sinalCtoDbm, limiteDb: activations.limiteDb, snapshot: activations.snapshot })
    .from(activations)
    .where(and(eq(activations.reservationId, reservationId), eq(activations.state, "online")))
    .orderBy(desc(activations.createdAt))
    .limit(1);
  if (!a) return null;
  // Sinal que o sistema leu na ONU durante a ativação: serve de sugestão para o técnico confirmar ao fechar a O.S.
  const onu = (a.snapshot as { sinal?: { onuDbm?: unknown } } | null)?.sinal?.onuDbm;
  return { sinalCtoDbm: a.sinalCtoDbm, limiteDb: a.limiteDb, minimoDbm: Number((a.sinalCtoDbm - a.limiteDb).toFixed(2)), onuDbm: typeof onu === "number" ? onu : null };
}

/** Janela aceita para a data da visita: não pode ter passado há mais de um dia nem ficar a mais de um ano. */
export const VISIT_PAST_TOLERANCE_MS = 24 * 3600_000;
export const VISIT_MAX_AHEAD_MS = 366 * 24 * 3600_000;

export type VisitPeriod = "manha" | "tarde";
/** Horário de referência (Brasília) que o `visitAt` guarda para cada período. */
const PERIOD_HOUR: Record<VisitPeriod, string> = { manha: "08", tarde: "14" };

const spDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const spHour = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" });

/** Período de uma visita antiga, só com data e hora: antes do meio-dia é manhã. */
export function periodOf(visitAt: Date): VisitPeriod {
  return Number(spHour.format(visitAt)) < 12 ? "manha" : "tarde";
}

/** Mesmo dia (em Brasília) no horário de referência do período. */
export function atPeriod(visitAt: Date, period: VisitPeriod): Date {
  return new Date(`${spDate.format(visitAt)}T${PERIOD_HOUR[period]}:00:00-03:00`);
}

export function assertVisitDate(visitAt: Date, now: Date) {
  if (Number.isNaN(visitAt.getTime())) throw new AppError(400, "dados_invalidos", "Data da visita inválida.");
  if (visitAt.getTime() < now.getTime() - VISIT_PAST_TOLERANCE_MS) {
    throw new AppError(422, "visita_no_passado", "A data da visita já passou. Escolha hoje ou uma data futura.");
  }
  if (visitAt.getTime() > now.getTime() + VISIT_MAX_AHEAD_MS) {
    throw new AppError(422, "visita_distante", "A data da visita está longe demais (máximo de um ano).");
  }
}

export interface OsData extends OsInput {
  fechadaPor: string;
}

/** Reserva do próprio parceiro; de outro parceiro ou inexistente é 404, igual. */
async function ownReservation(db: Db, user: SessionUser, id: string) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro fecham a O.S.");
  const [row] = await db
    .select()
    .from(portReservations)
    .where(and(eq(portReservations.id, id), eq(portReservations.partnerId, user.partnerId)));
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Reserva não encontrada.");
  return row;
}

export async function missingPhotoKinds(db: Db, reservationId: string): Promise<PhotoKind[]> {
  const rows = await db.select({ kind: photos.kind }).from(photos).where(eq(photos.reservationId, reservationId));
  const have = new Set(rows.map((r) => r.kind));
  return OS_REQUIRED_KINDS.filter((k) => !have.has(k));
}

export async function closeServiceOrder(db: Db, user: SessionUser, reservationId: string, input: OsInput, opts: { ip?: string | null; now?: Date } = {}) {
  const reservation = await ownReservation(db, user, reservationId);
  if (reservation.osClosedAt) throw new AppError(409, "os_ja_fechada", "Essa O.S. já foi fechada.");
  // A O.S. fecha depois que a ONU subiu: reserva já virou contrato.
  if (reservation.status !== "convertida") throw new AppError(409, "onu_nao_liberada", "Libere a ONU antes de fechar a O.S.");
  if (await getOsPhotosRequired(db)) {
    const missing = await missingPhotoKinds(db, reservation.id);
    if (missing.length) {
      throw new AppError(422, "fotos_obrigatorias", `Faltam fotos para fechar a O.S.: ${missing.join(", ")}.`);
    }
  }
  const now = opts.now ?? new Date();
  // Mesma régua da ativação: sinal final abaixo do mínimo só fecha com justificativa, que fica na O.S. e na auditoria.
  const ref = await signalReference(db, reservation.id);
  const justificativa = input.justificativaSinal?.trim() || null;
  const foraDoLimite = ref !== null && input.sinalFinalDbm < ref.minimoDbm;
  if (foraDoLimite && (!justificativa || justificativa.length < 10)) {
    throw new AppError(
      422,
      "sinal_fora_do_limite",
      `O sinal final (${input.sinalFinalDbm} dBm) está abaixo do mínimo aceitável (${ref!.minimoDbm} dBm). Refaça a medição ou explique o motivo (mínimo 10 caracteres).`,
    );
  }
  const data: OsData = {
    ...input,
    porta: input.porta?.trim() || null,
    observacao: input.observacao?.trim() || null,
    justificativaSinal: foraDoLimite ? justificativa : null,
    fechadaPor: user.id,
  };
  const [closed] = await db
    .update(portReservations)
    .set({ osClosedAt: now, osClosedBy: user.id, osData: data, visitStatus: "concluida", updatedAt: now })
    // O índice parcial não protege contra dois fechamentos simultâneos; a condição no UPDATE sim.
    .where(and(eq(portReservations.id, reservation.id), sql`${portReservations.osClosedAt} IS NULL`))
    .returning();
  if (!closed) throw new AppError(409, "os_ja_fechada", "Essa O.S. já foi fechada.");
  await recordAudit(db, {
    partnerId: reservation.partnerId,
    userId: user.id,
    action: "os.fechada",
    entity: "port_reservation",
    entityId: reservation.id,
    ip: opts.ip,
    data: {
      contract: reservation.contractNumber,
      sinalFinalDbm: input.sinalFinalDbm,
      serialOnu: input.serialOnu,
      porta: data.porta,
      ...(foraDoLimite ? { minimoDbm: ref!.minimoDbm, justificativaSinal: justificativa } : {}),
    },
  });
  return closed;
}

/** Linha da lista de instalações (uma por reserva viva ou convertida). */
export async function listInstallations(db: Db, user: SessionUser) {
  // Cliente cancelado depois de instalado continua na lista (histórico, fotos e O.S.); reserva cancelada antes disso não.
  const visible = or(inArray(portReservations.status, ["ativa", "convertida"]), and(eq(portReservations.status, "cancelada"), isNotNull(portReservations.osClosedAt)));
  const scope = user.role === "admin_speed" ? visible : and(eq(portReservations.partnerId, user.partnerId!), visible);
  const rows = await db
    .select({
      r: portReservations,
      partnerName: partners.name,
      planName: plans.name,
      planMbps: plans.speedMbps,
    })
    .from(portReservations)
    .leftJoin(partners, eq(partners.id, portReservations.partnerId))
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(scope)
    .orderBy(desc(portReservations.createdAt))
    .limit(300);
  const ids = rows.map((x) => x.r.id);
  const kinds = new Map<string, Set<string>>();
  const act = new Map<string, { state: string; serial: string }>();
  if (ids.length) {
    for (const p of await db.select({ rid: photos.reservationId, kind: photos.kind }).from(photos).where(inArray(photos.reservationId, ids))) {
      if (!kinds.has(p.rid)) kinds.set(p.rid, new Set());
      kinds.get(p.rid)!.add(p.kind);
    }
    // A mais recente de cada reserva.
    for (const a of await db
      .select({ rid: activations.reservationId, state: activations.state, serial: activations.serial })
      .from(activations)
      .where(inArray(activations.reservationId, ids))
      .orderBy(activations.createdAt)) {
      act.set(a.rid, { state: a.state, serial: a.serial });
    }
  }
  return rows.map(({ r, partnerName, planName, planMbps }) => ({
    id: r.id,
    partnerId: r.partnerId,
    partnerName: user.role === "admin_speed" ? partnerName : null,
    ctoName: r.ctoName,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    ctoLat: r.ctoLat,
    ctoLng: r.ctoLng,
    status: r.status,
    contract: r.contractNumber,
    nickname: r.nickname,
    planName: planName ?? null,
    planMbps: planMbps ?? null,
    visitAt: r.visitAt,
    visitPeriod: r.visitAt ? ((r.visitPeriod as VisitPeriod | null) ?? periodOf(r.visitAt)) : null,
    technician: r.technician,
    visitStatus: r.visitStatus,
    activationState: act.get(r.id)?.state ?? null,
    onuSerial: act.get(r.id)?.serial ?? null,
    photoKinds: [...(kinds.get(r.id) ?? [])],
    osClosedAt: r.osClosedAt,
    customerStatus: r.customerStatus,
    createdAt: r.createdAt,
  }));
}

/** Detalhe de uma instalação: a linha da lista mais os dados da O.S. fechada. */
export async function getInstallation(db: Db, user: SessionUser, id: string) {
  const list = await listInstallations(db, user);
  const row = list.find((x) => x.id === id);
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Instalação não encontrada.");
  const [r] = await db.select({ osData: portReservations.osData }).from(portReservations).where(eq(portReservations.id, id));
  const missing = await missingPhotoKinds(db, id);
  const ref = await signalReference(db, id);
  return {
    ...row,
    os: (r?.osData as OsData | null) ?? null,
    fotosFaltando: missing,
    fotosObrigatorias: await getOsPhotosRequired(db),
    sinalMinimoDbm: ref?.minimoDbm ?? null,
    sinalOnuLidoDbm: ref?.onuDbm ?? null,
  };
}

// ── Dados do cliente (planejamento, etapa 3): plano, apelido, visita e técnico ──

export interface ClienteInput {
  planId: string;
  /** Nome do assinante final: só para exibição e busca no portal. */
  nickname?: string | null;
  visitAt: Date;
  /** Sem período, vale o da hora de `visitAt`. */
  visitPeriod?: VisitPeriod;
  technician: string;
  /** Endereço da instalação; a criação do contrato usa o que ficou salvo aqui. */
  endereco?: ContractAddress;
}

/** Salva os dados do cliente na reserva. Mudar a data de uma visita já marcada vira "reagendada". */
export async function saveCliente(db: Db, user: SessionUser, reservationId: string, input: ClienteInput, opts: { ip?: string | null; now?: Date } = {}) {
  const reservation = await ownReservation(db, user, reservationId);
  if (reservation.status !== "ativa" && reservation.status !== "convertida") {
    throw new AppError(409, "reserva_indisponivel", "Essa reserva não está mais aberta.");
  }
  if (reservation.osClosedAt) throw new AppError(409, "os_ja_fechada", "A O.S. já foi fechada.");
  const [plan] = await db.select({ id: plans.id }).from(plans).where(and(eq(plans.id, input.planId), eq(plans.active, true)));
  if (!plan) throw new AppError(422, "plano_invalido", "Escolha um dos planos disponíveis.");

  // Com contrato já pedido o endereço está no sistema da Speed: mudar aqui não o altera, então não aceita.
  if (input.endereco) {
    const [contract] = await db
      .select({ id: contractRequests.id })
      .from(contractRequests)
      .where(and(eq(contractRequests.reservationId, reservation.id), sql`${contractRequests.state} <> 'falhou'`))
      .limit(1);
    if (contract) throw new AppError(409, "contrato_criado", "O contrato desse cliente já foi pedido: o endereço não muda mais por aqui.");
  }

  const period = input.visitPeriod ?? periodOf(input.visitAt);
  const visitAt = input.visitPeriod ? atPeriod(input.visitAt, input.visitPeriod) : input.visitAt;
  // Visita antiga sem período: o que vale é o dia e o período derivado da hora; só muda se o parceiro trocar.
  const moved = reservation.visitAt !== null && (reservation.visitAt.getTime() !== visitAt.getTime() || (reservation.visitPeriod ?? periodOf(reservation.visitAt)) !== period);
  const now = opts.now ?? new Date();
  // Só valida a data quando ela muda: editar o apelido de uma visita antiga não deve ser bloqueado.
  if (reservation.visitAt === null || moved) assertVisitDate(visitAt, now);
  const [updated] = await db
    .update(portReservations)
    .set({
      ...(input.endereco ? { installAddress: input.endereco } : {}),
      planId: input.planId,
      nickname: input.nickname?.trim() || null,
      visitAt,
      visitPeriod: period,
      technician: input.technician.trim(),
      visitStatus: moved ? "reagendada" : reservation.visitStatus,
      updatedAt: now,
    })
    .where(eq(portReservations.id, reservation.id))
    .returning();
  await recordAudit(db, {
    partnerId: reservation.partnerId,
    userId: user.id,
    action: moved ? "visita.reagendada" : "cliente.dados",
    entity: "port_reservation",
    entityId: reservation.id,
    ip: opts.ip,
    data: { planId: input.planId, visitAt, visitPeriod: period, technician: input.technician.trim(), de: moved ? reservation.visitAt : undefined },
  });
  return updated!;
}

/** Plano, visita e técnico são obrigatórios para liberar a ONU (o contrato do planejamento). */
export function clienteIncomplete(r: { planId: string | null; visitAt: Date | null; technician: string | null }): string[] {
  const missing: string[] = [];
  if (!r.planId) missing.push("plano");
  if (!r.visitAt) missing.push("data da visita");
  if (!r.technician) missing.push("técnico responsável");
  return missing;
}

/** Nomes de técnicos já usados pelo parceiro, para sugerir no formulário. */
export async function listTechnicians(db: Db, user: SessionUser): Promise<string[]> {
  if (!user.partnerId) return [];
  const rows = await db
    .selectDistinct({ technician: portReservations.technician })
    .from(portReservations)
    .where(and(eq(portReservations.partnerId, user.partnerId), sql`${portReservations.technician} IS NOT NULL`))
    .orderBy(portReservations.technician);
  return rows.map((r) => r.technician!).filter(Boolean);
}

// ── Agenda de visitas (planejamento, etapa 4) ──────────────────────────────

/** Visitas marcadas no intervalo [from, to), do parceiro (ou de todos, para a Speed). */
export async function listAgenda(db: Db, user: SessionUser, range: { from: Date; to: Date }) {
  const base = and(
    inArray(portReservations.status, ["ativa", "convertida"]),
    gte(portReservations.visitAt, range.from),
    lt(portReservations.visitAt, range.to),
  );
  const scope = user.role === "admin_speed" ? base : and(base, eq(portReservations.partnerId, user.partnerId!));
  const rows = await db
    .select({ r: portReservations, partnerName: partners.name, planName: plans.name })
    .from(portReservations)
    .leftJoin(partners, eq(partners.id, portReservations.partnerId))
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(scope)
    .orderBy(portReservations.visitAt)
    .limit(500);
  return rows.map(({ r, partnerName, planName }) => ({
    id: r.id,
    partnerName: user.role === "admin_speed" ? partnerName : null,
    contract: r.contractNumber,
    nickname: r.nickname,
    address: r.address,
    ctoName: r.ctoName,
    planName: planName ?? null,
    technician: r.technician,
    visitAt: r.visitAt!,
    visitPeriod: (r.visitPeriod as VisitPeriod | null) ?? periodOf(r.visitAt!),
    visitStatus: r.visitStatus,
    osClosedAt: r.osClosedAt,
  }));
}

/** Arrastar o card ou editar: muda a data (e, se vier, o técnico). Visita já marcada que muda de data vira "reagendada". */
export async function reschedule(db: Db, user: SessionUser, reservationId: string, input: { visitAt: Date; visitPeriod?: VisitPeriod; technician?: string }, opts: { ip?: string | null; now?: Date } = {}) {
  const reservation = await ownReservation(db, user, reservationId);
  if (reservation.status !== "ativa" && reservation.status !== "convertida") {
    throw new AppError(409, "reserva_indisponivel", "Essa reserva não está mais aberta.");
  }
  if (reservation.osClosedAt) throw new AppError(409, "os_ja_fechada", "A O.S. já foi fechada.");
  if (!reservation.visitAt) throw new AppError(409, "sem_visita", "Preencha os dados do cliente antes de reagendar.");
  const period = input.visitPeriod ?? periodOf(input.visitAt);
  const visitAt = input.visitPeriod ? atPeriod(input.visitAt, input.visitPeriod) : input.visitAt;
  const changedDate = reservation.visitAt.getTime() !== visitAt.getTime() || (reservation.visitPeriod ?? periodOf(reservation.visitAt)) !== period;
  const now = opts.now ?? new Date();
  if (changedDate) assertVisitDate(visitAt, now);
  const [updated] = await db
    .update(portReservations)
    .set({
      visitAt,
      visitPeriod: period,
      technician: input.technician?.trim() || reservation.technician,
      visitStatus: changedDate ? "reagendada" : reservation.visitStatus,
      updatedAt: now,
    })
    .where(eq(portReservations.id, reservation.id))
    .returning();
  if (changedDate) {
    await recordAudit(db, {
      partnerId: reservation.partnerId,
      userId: user.id,
      action: "visita.reagendada",
      entity: "port_reservation",
      entityId: reservation.id,
      ip: opts.ip,
      data: { de: reservation.visitAt, para: visitAt, visitPeriod: period, technician: updated!.technician },
    });
  }
  return updated!;
}
