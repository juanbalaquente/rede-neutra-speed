import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { ctoLimits, partners } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";

export type LimitSource = "cto_parceiro" | "cto" | "parceiro";

/**
 * Percentual máximo de ocupação de cada CTO para o parceiro. Ordem: regra da CTO para aquele parceiro, regra da CTO para
 * todos, e por fim o percentual padrão do parceiro. Planejamento: "configurável pela Speed, por parceiro e por CTO".
 */
export async function effectiveMaxPct(db: Db, partnerId: string, ctoIds: string[], partnerPct: number): Promise<Map<string, { pct: number; source: LimitSource }>> {
  const out = new Map<string, { pct: number; source: LimitSource }>(ctoIds.map((id) => [id, { pct: partnerPct, source: "parceiro" }]));
  if (!ctoIds.length) return out;
  const rows = await db
    .select()
    .from(ctoLimits)
    .where(and(inArray(ctoLimits.ctoId, ctoIds), or(eq(ctoLimits.partnerId, partnerId), isNull(ctoLimits.partnerId))));
  // A regra da CTO para todos entra primeiro; a do parceiro sobrescreve.
  for (const r of rows.filter((x) => x.partnerId === null)) out.set(r.ctoId, { pct: r.maxPct, source: "cto" });
  for (const r of rows.filter((x) => x.partnerId !== null)) out.set(r.ctoId, { pct: r.maxPct, source: "cto_parceiro" });
  return out;
}

export const ctoLimitView = (r: typeof ctoLimits.$inferSelect, partnerName: string | null) => ({
  id: r.id,
  partnerId: r.partnerId,
  partnerName,
  ctoId: r.ctoId,
  maxPct: r.maxPct,
  reason: r.reason,
  createdAt: r.createdAt,
});

export async function listCtoLimits(db: Db) {
  const rows = await db
    .select({ limit: ctoLimits, partnerName: partners.name })
    .from(ctoLimits)
    .leftJoin(partners, eq(partners.id, ctoLimits.partnerId))
    .orderBy(desc(ctoLimits.createdAt));
  return rows.map((r) => ctoLimitView(r.limit, r.partnerName));
}

export interface CtoLimitInput {
  partnerId: string | null;
  ctoId: string;
  maxPct: number;
  reason: string;
}

/** Cria ou troca a regra de uma CTO (para um parceiro ou para todos). Liberar caso a caso é maxPct 100 com o motivo. */
export async function setCtoLimit(db: Db, user: SessionUser, input: CtoLimitInput, ip?: string | null) {
  if (input.partnerId) {
    const [p] = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, input.partnerId));
    if (!p) throw new AppError(404, "parceiro_nao_encontrado", "Parceiro não encontrado.");
  }
  const where = input.partnerId ? and(eq(ctoLimits.partnerId, input.partnerId), eq(ctoLimits.ctoId, input.ctoId)) : and(isNull(ctoLimits.partnerId), eq(ctoLimits.ctoId, input.ctoId));
  const [before] = await db.select().from(ctoLimits).where(where);
  const values = { partnerId: input.partnerId, ctoId: input.ctoId, maxPct: input.maxPct, reason: input.reason.trim(), createdBy: user.id };
  const [row] = before ? await db.update(ctoLimits).set(values).where(eq(ctoLimits.id, before.id)).returning() : await db.insert(ctoLimits).values(values).returning();
  await recordAudit(db, {
    partnerId: input.partnerId,
    userId: user.id,
    action: "config.limite_cto",
    entity: "cto_limit",
    entityId: row!.id,
    ip,
    data: { ctoId: input.ctoId, before: before?.maxPct ?? null, after: input.maxPct, motivo: values.reason },
  });
  const [partner] = input.partnerId ? await db.select({ name: partners.name }).from(partners).where(eq(partners.id, input.partnerId)) : [];
  return ctoLimitView(row!, partner?.name ?? null);
}

export async function deleteCtoLimit(db: Db, user: SessionUser, id: string, ip?: string | null) {
  const [row] = await db.delete(ctoLimits).where(eq(ctoLimits.id, id)).returning();
  if (!row) throw new AppError(404, "limite_nao_encontrado", "Regra não encontrada.");
  await recordAudit(db, { partnerId: row.partnerId, userId: user.id, action: "config.limite_cto_removido", entity: "cto_limit", entityId: row.id, ip, data: { ctoId: row.ctoId, era: row.maxPct } });
}
