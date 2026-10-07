import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { partners, portReservations, viabilityQueries } from "../db/schema.js";
import { IntegrationError, type NetworkMap } from "../integrations/types.js";
import { AppError, isUniqueViolation } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import { isStale } from "./freshness.js";

export const LIVE_STATUSES = ["ativa", "convertida"] as const;

/** Por quanto tempo uma consulta de viabilidade autoriza reservar as CTOs que listou. */
const VIABILITY_VALID_MS = 24 * 3600_000;

/** Expira reservas vencidas e devolve a porta ao pool. Idempotente. */
export async function expireOverdueReservations(db: Db, now = new Date()): Promise<number> {
  const expired = await db
    .update(portReservations)
    .set({ status: "expirada", updatedAt: now })
    .where(and(eq(portReservations.status, "ativa"), lt(portReservations.expiresAt, now)))
    .returning({ id: portReservations.id, partnerId: portReservations.partnerId });
  for (const r of expired) {
    await recordAudit(db, {
      partnerId: r.partnerId,
      userId: null,
      action: "reserva.expirada",
      entity: "port_reservation",
      entityId: r.id,
    });
  }
  return expired.length;
}

/** Portas com reserva viva (de qualquer parceiro), por CTO. */
export async function livePortsByCto(db: Db, ctoIds: string[]): Promise<Map<string, Set<number>>> {
  const map = new Map<string, Set<number>>();
  if (ctoIds.length === 0) return map;
  const rows = await db
    .select({ ctoId: portReservations.ctoId, port: portReservations.port })
    .from(portReservations)
    .where(and(inArray(portReservations.ctoId, ctoIds), inArray(portReservations.status, [...LIVE_STATUSES])));
  for (const r of rows) {
    if (!map.has(r.ctoId)) map.set(r.ctoId, new Set());
    map.get(r.ctoId)!.add(r.port);
  }
  return map;
}

/** Quantas portas o parceiro ocupa (reserva viva ou ativação) em cada CTO. */
export async function partnerUsageByCto(db: Db, partnerId: string, ctoIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ctoIds.length === 0) return map;
  const rows = await db
    .select({ ctoId: portReservations.ctoId, n: count() })
    .from(portReservations)
    .where(
      and(
        eq(portReservations.partnerId, partnerId),
        inArray(portReservations.ctoId, ctoIds),
        inArray(portReservations.status, [...LIVE_STATUSES]),
      ),
    )
    .groupBy(portReservations.ctoId);
  for (const r of rows) map.set(r.ctoId, Number(r.n));
  return map;
}

/** Máximo de portas que o parceiro pode ocupar numa CTO, pelo limite em %. */
export function maxPortsForPartner(totalPorts: number, maxPct: number): number {
  return Math.floor((totalPorts * maxPct) / 100);
}

export interface CreateReservationInput {
  ctoId: string;
  port: number;
  address: string;
  lat?: number | null;
  lng?: number | null;
}

export async function createReservation(
  db: Db,
  network: NetworkMap,
  user: SessionUser,
  input: CreateReservationInput,
  opts: { hours: number; ip?: string | null; now?: Date },
) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro reservam portas.");
  const now = opts.now ?? new Date();
  await expireOverdueReservations(db, now);

  // A porta só pode vir de uma consulta de viabilidade recente do próprio parceiro,
  // para este endereço, que tenha listado esta CTO. Sem isso, qualquer CTO da rede seria reservável.
  const [listed] = await db
    .select({ result: viabilityQueries.result })
    .from(viabilityQueries)
    .where(
      and(
        eq(viabilityQueries.partnerId, user.partnerId),
        eq(viabilityQueries.address, input.address.trim()),
        gte(viabilityQueries.createdAt, new Date(now.getTime() - VIABILITY_VALID_MS)),
        sql`${viabilityQueries.result} -> 'ctos' @> ${JSON.stringify([{ ctoId: input.ctoId }])}::jsonb`,
      ),
    )
    .orderBy(desc(viabilityQueries.createdAt))
    .limit(1);
  if (!listed) {
    throw new AppError(422, "viabilidade_necessaria", "Consulte a viabilidade deste endereço antes de reservar (a consulta vale por 24 horas).");
  }
  // A consulta mais recente marcou a CTO para conferência (fontes divergentes ou dado fraco).
  const entry = (listed.result as { ctos?: { ctoId: string; blocked: string | null }[] } | null)?.ctos?.find((c) => c.ctoId === input.ctoId);
  if (entry?.blocked === "conferir") {
    throw new AppError(409, "porta_nao_confirmada", "As fontes de dados divergem nessa CTO. A Speed precisa conferir antes de vender.");
  }

  // Confere a porta na fonte da verdade antes de travar.
  // Na reserva a leitura é fresca (só aquela caixa e a gêmea), não o snapshot da viabilidade.
  const cto = await network.getCtoPorts(input.ctoId, { fresh: true });
  // Caixa recriada com outro id não é "CTO sumiu": a Speed confere.
  if (!cto) throw new AppError(409, "porta_nao_confirmada", "Não encontramos essa CTO na leitura atual da rede. A Speed precisa conferir antes de vender.");
  if (cto.ctoId !== input.ctoId) throw new IntegrationError("rede", "a fonte devolveu outro id de CTO");
  const port = cto.ports.find((p) => p.port === input.port);
  if (!port) throw new AppError(422, "porta_inexistente", "Essa porta não existe nessa CTO.");
  if (cto.confidence === "conferir" || port.state === "desconhecida" || isStale(cto.updatedAt)) {
    throw new AppError(409, "porta_nao_confirmada", "Não foi possível confirmar essa porta. A Speed precisa conferir a CTO.");
  }
  if (port.state === "ocupada") throw new AppError(409, "porta_ocupada", "Essa porta já está ocupada na rede.");

  const partnerId = user.partnerId;
  try {
    return await db.transaction(async (tx) => {
      // Trava a linha do parceiro: serializa reservas simultâneas dele.
      const [partner] = await tx.select().from(partners).where(eq(partners.id, partnerId)).for("update");
      if (!partner || partner.status !== "ativo") throw new AppError(403, "parceiro_bloqueado", "Parceiro bloqueado.");

      const [active] = await tx
        .select({ n: count() })
        .from(portReservations)
        .where(and(eq(portReservations.partnerId, partnerId), eq(portReservations.status, "ativa")));
      if (Number(active?.n ?? 0) >= partner.maxActiveReservations) {
        throw new AppError(
          409,
          "limite_reservas",
          `Limite de ${partner.maxActiveReservations} reservas simultâneas atingido.`,
        );
      }

      const usage = (await partnerUsageByCto(tx as Db, partnerId, [input.ctoId])).get(input.ctoId) ?? 0;
      if (usage + 1 > maxPortsForPartner(cto.totalPorts, partner.maxCtoOccupancyPct)) {
        throw new AppError(409, "limite_ocupacao_cto", "Limite de ocupação dessa CTO para o parceiro atingido.");
      }

      const expiresAt = new Date(now.getTime() + opts.hours * 3600_000);
      const [created] = await tx
        .insert(portReservations)
        .values({
          partnerId,
          userId: user.id,
          ctoId: input.ctoId,
          ctoName: cto.name,
          port: input.port,
          totalPorts: cto.totalPorts,
          address: input.address,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          status: "ativa",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await recordAudit(tx as Db, {
        partnerId,
        userId: user.id,
        action: "reserva.criada",
        entity: "port_reservation",
        entityId: created!.id,
        ip: opts.ip,
        data: { ctoId: input.ctoId, cto: cto.name, port: input.port, expiresAt },
      });
      return created!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "porta_reservada", "Essa porta acabou de ser reservada.");
    throw e;
  }
}

export async function cancelReservation(
  db: Db,
  user: SessionUser,
  id: string,
  reason: string | null,
  opts: { ip?: string | null; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const isAdmin = user.role === "admin_speed";
  if (isAdmin && !reason?.trim()) throw new AppError(422, "motivo_obrigatorio", "Informe o motivo do cancelamento.");

  const scope = isAdmin
    ? eq(portReservations.id, id)
    : and(eq(portReservations.id, id), eq(portReservations.partnerId, user.partnerId!));
  const [updated] = await db
    .update(portReservations)
    .set({ status: "cancelada", cancelReason: reason, cancelledBy: user.id, updatedAt: now })
    .where(and(scope, eq(portReservations.status, "ativa")))
    .returning();
  if (!updated) {
    // Não diferencia "não existe" de "é de outro parceiro": isolamento total.
    throw new AppError(404, "reserva_nao_encontrada", "Reserva ativa não encontrada.");
  }
  await recordAudit(db, {
    partnerId: updated.partnerId,
    userId: user.id,
    action: "reserva.cancelada",
    entity: "port_reservation",
    entityId: updated.id,
    ip: opts.ip,
    data: { reason, byAdmin: isAdmin },
  });
  return updated;
}

export async function listReservations(db: Db, user: SessionUser, status?: string) {
  await expireOverdueReservations(db);
  const filters = [];
  if (user.role !== "admin_speed") filters.push(eq(portReservations.partnerId, user.partnerId!));
  if (status) filters.push(sql`${portReservations.status} = ${status}`);
  return db
    .select()
    .from(portReservations)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(portReservations.createdAt))
    .limit(200);
}
