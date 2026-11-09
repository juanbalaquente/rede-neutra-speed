import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { capacityRequests, partners, portReservations, viabilityQueries } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";

const VIABILITY_VALID_MS = 24 * 3600_000;

interface ListedCto {
  ctoId: string;
  name: string;
  regiao: string | null;
  location: { lat: number; lng: number } | null;
  totalVagas: number;
  blocked: string | null;
  motivos?: string[];
}

export interface CapacityRequestInput {
  ctoId: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
}

/** O atendente pede a vaga numa CTO que a viabilidade listou mas não deixou reservar. */
export async function createCapacityRequest(
  db: Db,
  user: SessionUser,
  input: CapacityRequestInput,
  opts: { ip?: string | null; now?: Date } = {},
) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro pedem vaga.");
  const partnerId = user.partnerId;
  const now = opts.now ?? new Date();
  const address = input.address.trim();

  const [listed] = await db
    .select({ result: viabilityQueries.result })
    .from(viabilityQueries)
    .where(
      and(
        eq(viabilityQueries.partnerId, partnerId),
        eq(viabilityQueries.address, address),
        gte(viabilityQueries.createdAt, new Date(now.getTime() - VIABILITY_VALID_MS)),
        sql`${viabilityQueries.result} -> 'ctos' @> ${JSON.stringify([{ ctoId: input.ctoId }])}::jsonb`,
      ),
    )
    .orderBy(desc(viabilityQueries.createdAt))
    .limit(1);
  if (!listed) {
    throw new AppError(422, "viabilidade_necessaria", "Consulte a viabilidade deste endereço antes de pedir a vaga (a consulta vale por 24 horas).");
  }
  const entry = (listed.result as { ctos?: ListedCto[] } | null)?.ctos?.find((c) => c.ctoId === input.ctoId);
  if (!entry) throw new AppError(422, "viabilidade_necessaria", "Essa CTO não apareceu na consulta deste endereço.");
  const blockedReason = entry.blocked;
  if (blockedReason === null) {
    throw new AppError(409, "cto_com_vaga", "Essa CTO tem vaga livre: reserve direto, sem pedido.");
  }

  return db.transaction(async (tx) => {
    const [partner] = await tx.select().from(partners).where(eq(partners.id, partnerId)).for("update");
    if (!partner || partner.status !== "ativo") throw new AppError(403, "parceiro_bloqueado", "Parceiro bloqueado.");

    const [open] = await tx
      .select({ n: count() })
      .from(capacityRequests)
      .where(and(eq(capacityRequests.partnerId, partnerId), eq(capacityRequests.status, "pendente")));
    if (Number(open?.n ?? 0) >= partner.maxActiveReservations) {
      throw new AppError(409, "limite_pedidos", `Limite de ${partner.maxActiveReservations} pedidos de vaga em espera atingido.`);
    }
    const [dup] = await tx
      .select({ id: capacityRequests.id })
      .from(capacityRequests)
      .where(
        and(
          eq(capacityRequests.partnerId, partnerId),
          eq(capacityRequests.ctoId, input.ctoId),
          eq(capacityRequests.address, address),
          eq(capacityRequests.status, "pendente"),
        ),
      );
    if (dup) throw new AppError(409, "pedido_existente", "Já existe um pedido de vaga em espera para esta CTO e este endereço.");

    const [created] = await tx
      .insert(capacityRequests)
      .values({
        partnerId,
        userId: user.id,
        ctoId: input.ctoId,
        ctoName: entry.name,
        regiao: entry.regiao,
        address,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        ctoLat: entry.location?.lat ?? null,
        ctoLng: entry.location?.lng ?? null,
        totalVagas: entry.totalVagas || null,
        blockedReason,
        motivos: entry.motivos ?? [],
        createdAt: now,
      })
      .returning();
    await recordAudit(tx as Db, {
      partnerId,
      userId: user.id,
      action: "pedido_vaga.criado",
      entity: "capacity_request",
      entityId: created!.id,
      ip: opts.ip,
      data: { ctoId: input.ctoId, cto: entry.name, motivo: blockedReason },
    });
    return created!;
  });
}

/** O parceiro vê só os pedidos dele; a Speed vê todos, com o nome do parceiro. */
export async function listCapacityRequests(db: Db, user: SessionUser, status?: string) {
  const filters = [];
  if (user.role !== "admin_speed") filters.push(eq(capacityRequests.partnerId, user.partnerId!));
  if (status) filters.push(eq(capacityRequests.status, status));
  const rows = await db
    .select({ request: capacityRequests, partnerName: partners.name })
    .from(capacityRequests)
    .innerJoin(partners, eq(partners.id, capacityRequests.partnerId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(capacityRequests.createdAt))
    .limit(200);
  // Os motivos técnicos são da Speed.
  return rows.map(({ request, partnerName }) => ({
    ...request,
    motivos: user.role === "admin_speed" ? request.motivos : [],
    partnerName,
  }));
}

export async function cancelCapacityRequest(db: Db, user: SessionUser, id: string, opts: { ip?: string | null } = {}) {
  const [updated] = await db
    .update(capacityRequests)
    .set({ status: "cancelado", decidedAt: new Date() })
    .where(and(eq(capacityRequests.id, id), eq(capacityRequests.partnerId, user.partnerId!), eq(capacityRequests.status, "pendente")))
    .returning();
  // Não diferencia "não existe" de "é de outro parceiro".
  if (!updated) throw new AppError(404, "pedido_nao_encontrado", "Pedido de vaga em espera não encontrado.");
  await recordAudit(db, { partnerId: updated.partnerId, userId: user.id, action: "pedido_vaga.cancelado", entity: "capacity_request", entityId: id, ip: opts.ip });
  return updated;
}

/** A Speed confirma (nasce uma reserva normal de 48 h, sem a trava de vagas) ou recusa com motivo. */
export async function decideCapacityRequest(
  db: Db,
  admin: SessionUser,
  id: string,
  input: { decision: "confirmar" | "recusar"; note?: string | null },
  opts: { hours: number; ip?: string | null; now?: Date },
) {
  const now = opts.now ?? new Date();
  const note = input.note?.trim() || null;
  if (input.decision === "recusar" && (!note || note.length < 10)) {
    throw new AppError(422, "motivo_obrigatorio", "Informe o motivo da recusa (mínimo 10 caracteres): o parceiro vai lê-lo.");
  }

  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(capacityRequests).where(eq(capacityRequests.id, id)).for("update");
    if (!req) throw new AppError(404, "pedido_nao_encontrado", "Pedido de vaga não encontrado.");
    if (req.status !== "pendente") throw new AppError(409, "pedido_ja_decidido", "Esse pedido já foi decidido.");

    let reservationId: string | null = null;
    if (input.decision === "confirmar") {
      const [partner] = await tx.select().from(partners).where(eq(partners.id, req.partnerId)).for("update");
      if (!partner || partner.status !== "ativo") throw new AppError(409, "parceiro_bloqueado", "O parceiro está bloqueado.");
      const [reservation] = await tx
        .insert(portReservations)
        .values({
          partnerId: req.partnerId,
          userId: req.userId,
          ctoId: req.ctoId,
          ctoName: req.ctoName,
          port: null,
          totalPorts: req.totalVagas,
          address: req.address,
          lat: req.lat,
          lng: req.lng,
          ctoLat: req.ctoLat,
          ctoLng: req.ctoLng,
          status: "ativa",
          expiresAt: new Date(now.getTime() + opts.hours * 3600_000),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: portReservations.id });
      reservationId = reservation!.id;
    }

    const [updated] = await tx
      .update(capacityRequests)
      .set({
        status: input.decision === "confirmar" ? "confirmado" : "recusado",
        decisionNote: note,
        decidedBy: admin.id,
        decidedAt: now,
        reservationId,
      })
      .where(eq(capacityRequests.id, id))
      .returning();
    await recordAudit(tx as Db, {
      partnerId: req.partnerId,
      userId: admin.id,
      action: input.decision === "confirmar" ? "pedido_vaga.confirmado" : "pedido_vaga.recusado",
      entity: "capacity_request",
      entityId: id,
      ip: opts.ip,
      data: { ctoId: req.ctoId, cto: req.ctoName, note, reservationId },
    });
    if (reservationId) {
      await recordAudit(tx as Db, {
        partnerId: req.partnerId,
        userId: admin.id,
        action: "reserva.criada",
        entity: "port_reservation",
        entityId: reservationId,
        ip: opts.ip,
        data: { ctoId: req.ctoId, cto: req.ctoName, origem: "pedido_vaga", pedido: id },
      });
    }
    return updated!;
  });
}
