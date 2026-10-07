import { eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { partners, plans, viabilityQueries } from "../db/schema.js";
import type { NetworkMap } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";
import { isStale } from "./freshness.js";
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
  /** null = a fonte não resolveu a caixa: a CTO aparece, mas não vende. */
  ctoId: string | null;
  name: string;
  distanceM: number;
  location: { lat: number; lng: number } | null;
  totalPorts: number;
  freePorts: number[];
  /** Por que a CTO não serve para este parceiro, quando não serve. */
  blockedReason: "sem_porta_livre" | "limite_ocupacao" | "conferir" | null;
  /** Há outra CTO muito próxima: a certa só se confirma em campo. */
  proximaAmbigua: boolean;
  /** Por que está em "conferir". Só a Speed vê; para o parceiro vai vazio. */
  motivos: string[];
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
  const ids = candidates.map((c) => c.ctoId).filter((id): id is string => id !== null);
  const reserved = await livePortsByCto(db, ids);
  const usage = partner ? await partnerUsageByCto(db, partner.id, ids) : new Map<string, number>();

  const ctos: ViabilityCto[] = [];
  for (const c of candidates) {
    const base = { ctoId: c.ctoId, name: c.name, distanceM: c.distanceM, location: c.location, proximaAmbigua: c.proximaAmbigua };
    const conferir = (motivos: string[], totalPorts = 0): ViabilityCto => ({ ...base, totalPorts, freePorts: [], blockedReason: "conferir", motivos });

    // Sem id a caixa não é reservável, mas a consulta (e a demanda) continua registrada.
    if (c.ctoId === null) {
      ctos.push(conferir(["cto_sem_id"]));
      continue;
    }
    const detail = await network.getCtoPorts(c.ctoId);
    // A caixa pode ter sido recriada com outro id: é "conferir", não "CTO sumiu".
    if (!detail) {
      ctos.push(conferir(["cto_nao_encontrada"]));
      continue;
    }

    const taken = reserved.get(c.ctoId) ?? new Set<number>();
    const free = detail.ports.filter((p) => p.state === "livre" && !taken.has(p.port)).map((p) => p.port);
    // Duas fontes precisam concordar: o mapa (Codemaps) diz quantas portas estão livres e a
    // ocupação (OLTCloud) diz quais. Porta sem registro ainda pode ser livre, então entra na
    // conta, mas nunca é oferecida. Mapa sem contagem (null) também não prova nada.
    const confirmed = detail.ports.filter((p) => p.state === "livre").length;
    const unknown = detail.ports.filter((p) => p.state === "desconhecida").length;
    const portalMotivos: string[] = [];
    if (c.freePorts === null) portalMotivos.push("mapa_sem_contagem");
    else if (c.freePorts !== confirmed + unknown) portalMotivos.push("mapa_diverge_ocupacao");
    if (isStale(detail.updatedAt)) portalMotivos.push("dado_antigo");
    const motivos = [...detail.motivos, ...portalMotivos];

    if (detail.confidence === "conferir" || portalMotivos.length > 0) {
      ctos.push(conferir(motivos.length ? motivos : ["fonte_marcou_conferir"], detail.totalPorts));
      continue;
    }
    let blockedReason: ViabilityCto["blockedReason"] = free.length === 0 ? "sem_porta_livre" : null;
    if (!blockedReason && partner) {
      const used = usage.get(c.ctoId) ?? 0;
      if (used + 1 > maxPortsForPartner(detail.totalPorts, partner.maxCtoOccupancyPct)) blockedReason = "limite_ocupacao";
    }
    ctos.push({ ...base, totalPorts: detail.totalPorts, freePorts: blockedReason ? [] : free, blockedReason, motivos: [] });
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
      result: {
        ctos: ctos.map((c) => ({ ctoId: c.ctoId, name: c.name, free: c.freePorts.length, blocked: c.blockedReason, ambiguous: c.proximaAmbigua, motivos: c.motivos })),
        // Contagem de cada fonte, para a Speed entender por que uma CTO ficou em "conferir".
        sources: candidates.map((c) => ({ ctoId: c.ctoId, mapFree: c.freePorts })),
      },
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

  // Os motivos técnicos são da Speed: o parceiro só vê "a Speed precisa conferir".
  const visible = user.role === "admin_speed" ? ctos : ctos.map((c) => ({ ...c, motivos: [] }));
  return { queryId: saved!.id, viable, point: nearby.point, ctos: visible, plans: activePlans };
}
