import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, partners, photos, plans, portReservations, settings, type PhotoKind } from "../db/schema.js";
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
  const data: OsData = { ...input, porta: input.porta?.trim() || null, observacao: input.observacao?.trim() || null, fechadaPor: user.id };
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
    data: { contract: reservation.contractNumber, sinalFinalDbm: input.sinalFinalDbm, serialOnu: input.serialOnu, porta: data.porta },
  });
  return closed;
}

/** Linha da lista de instalações (uma por reserva viva ou convertida). */
export async function listInstallations(db: Db, user: SessionUser) {
  const scope =
    user.role === "admin_speed"
      ? inArray(portReservations.status, ["ativa", "convertida"])
      : and(eq(portReservations.partnerId, user.partnerId!), inArray(portReservations.status, ["ativa", "convertida"]));
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
    status: r.status,
    contract: r.contractNumber,
    nickname: r.nickname,
    planName: planName ?? null,
    planMbps: planMbps ?? null,
    visitAt: r.visitAt,
    technician: r.technician,
    visitStatus: r.visitStatus,
    activationState: act.get(r.id)?.state ?? null,
    onuSerial: act.get(r.id)?.serial ?? null,
    photoKinds: [...(kinds.get(r.id) ?? [])],
    osClosedAt: r.osClosedAt,
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
  return { ...row, os: (r?.osData as OsData | null) ?? null, fotosFaltando: missing, fotosObrigatorias: await getOsPhotosRequired(db) };
}
