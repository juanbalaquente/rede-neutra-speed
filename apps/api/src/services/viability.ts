import { eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { partners, plans, viabilityQueries } from "../db/schema.js";
import type { NetworkMap } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import {
  expireOverdueReservations,
  livePortsByCto,
  maxPortsForPartner,
  partnerUsageByCto,
} from "./reservations.js";

export const VIABILITY_RADIUS_M = 300;
const MAX_CTOS = 5;

/** Plus Code (ex.: 438Q+28W): o geocoder do Codemaps cai no centro da cidade sem avisar. */
const PLUS_CODE_RE = /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/i;

export interface ViabilityCto {
  name: string;
  distanceM: number;
  location: { lat: number; lng: number } | null;
  totalPorts: number;
  freePorts: number[];
  /** Por que a CTO não serve para este parceiro, quando não serve. */
  blockedReason: "sem_porta_livre" | "limite_ocupacao" | "sem_dados_de_porta" | null;
}

export interface ViabilityResult {
  queryId: string;
  viable: boolean;
  point: { lat: number; lng: number } | null;
  ctos: ViabilityCto[];
  plans: { id: string; name: string; speedMbps: number }[];
}

export async function runViability(
  db: Db,
  network: NetworkMap,
  user: SessionUser,
  address: string,
  opts: { ip?: string | null } = {},
): Promise<ViabilityResult> {
  const trimmed = address.trim();
  if (PLUS_CODE_RE.test(trimmed)) {
    throw new AppError(422, "plus_code", "Use o endereço com rua e número. Plus Code não é aceito pelo mapa.");
  }
  await expireOverdueReservations(db);

  const partner = user.partnerId
    ? (await db.select().from(partners).where(eq(partners.id, user.partnerId)))[0]
    : undefined;

  const nearby = await network.findNearbyCtos(trimmed, VIABILITY_RADIUS_M);
  const candidates = nearby.ctos.slice(0, MAX_CTOS);
  const names = candidates.map((c) => c.name);
  const reserved = await livePortsByCto(db, names);
  const usage = partner ? await partnerUsageByCto(db, partner.id, names) : new Map<string, number>();

  const ctos: ViabilityCto[] = [];
  for (const c of candidates) {
    const detail = await network.getCtoPorts(c.name);
    if (!detail) {
      ctos.push({ name: c.name, distanceM: c.distanceM, location: c.location, totalPorts: 0, freePorts: [], blockedReason: "sem_dados_de_porta" });
      continue;
    }
    const taken = reserved.get(c.name) ?? new Set<number>();
    const free = detail.ports.filter((p) => !p.occupied && !taken.has(p.port)).map((p) => p.port);
    let blockedReason: ViabilityCto["blockedReason"] = free.length === 0 ? "sem_porta_livre" : null;
    if (!blockedReason && partner) {
      const used = usage.get(c.name) ?? 0;
      if (used + 1 > maxPortsForPartner(detail.totalPorts, partner.maxCtoOccupancyPct)) blockedReason = "limite_ocupacao";
    }
    ctos.push({
      name: c.name,
      distanceM: c.distanceM,
      location: c.location,
      totalPorts: detail.totalPorts,
      freePorts: blockedReason ? [] : free,
      blockedReason,
    });
  }

  const viable = ctos.some((c) => c.blockedReason === null);
  const activePlans = viable
    ? await db
        .select({ id: plans.id, name: plans.name, speedMbps: plans.speedMbps })
        .from(plans)
        .where(eq(plans.active, true))
        .orderBy(plans.speedMbps)
    : [];

  const reason = viable ? null : ctos.length === 0 ? "nenhuma_cto_no_raio" : "sem_porta_disponivel";
  const [saved] = await db
    .insert(viabilityQueries)
    .values({
      partnerId: user.partnerId,
      userId: user.id,
      address: trimmed,
      lat: nearby.point?.lat ?? null,
      lng: nearby.point?.lng ?? null,
      viable,
      reason,
      result: { ctos: ctos.map((c) => ({ name: c.name, free: c.freePorts.length, blocked: c.blockedReason })) },
    })
    .returning({ id: viabilityQueries.id });
  await recordAudit(db, {
    partnerId: user.partnerId,
    userId: user.id,
    action: "viabilidade.consultada",
    entity: "viability_query",
    entityId: saved!.id,
    ip: opts.ip,
    data: { viable },
  });

  return { queryId: saved!.id, viable, point: nearby.point, ctos, plans: activePlans };
}
