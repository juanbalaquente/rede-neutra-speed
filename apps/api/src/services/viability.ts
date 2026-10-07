import { eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { partners, plans, viabilityQueries } from "../db/schema.js";
import type { NetworkMap } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import { isStale } from "./freshness.js";
import {
  expireOverdueReservations,
  isRegionAllowed,
  liveReservationsByCto,
  maxVagasForPartner,
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
  regiao: string | null;
  /** Total de vagas (saídas de splitter) da CTO. */
  totalVagas: number;
  /** Vagas que este parceiro pode reservar agora (livres menos reservas vivas); 0 se bloqueada. */
  vagas: number;
  /** Por que a CTO não serve para este parceiro, quando não serve. */
  blockedReason: "sem_vaga_livre" | "limite_ocupacao" | "conferir" | null;
  /** Há outra CTO muito próxima: a certa só se confirma em campo. */
  proximaAmbigua: boolean;
  /** Por que está em "conferir" (ou motivo informativo). Só a Speed vê; para o parceiro vai vazio. */
  motivos: string[];
}

export interface ViabilityResult {
  queryId: string;
  viable: boolean;
  /** Havia CTOs perto, mas nenhuma na área liberada ao parceiro. */
  foraDaArea: boolean;
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
  // Só a área liberada ao parceiro: CTO com sigla fora da lista (ou sem sigla) não é oferecida.
  const inArea = partner ? nearby.ctos.filter((c) => isRegionAllowed(partner.allowedRegions, c.regiao)) : nearby.ctos;
  const foraDaArea = nearby.ctos.length > 0 && inArea.length === 0;
  const candidates = inArea.slice(0, MAX_CTOS);
  const ids = candidates.map((c) => c.ctoId).filter((id): id is string => id !== null);
  const reserved = await liveReservationsByCto(db, ids);
  const usage = partner ? await partnerUsageByCto(db, partner.id, ids) : new Map<string, number>();

  const ctos: ViabilityCto[] = [];
  for (const c of candidates) {
    const base = { ctoId: c.ctoId, name: c.name, distanceM: c.distanceM, location: c.location, regiao: c.regiao, proximaAmbigua: c.proximaAmbigua };
    const conferir = (motivos: string[], totalVagas = 0): ViabilityCto => ({ ...base, totalVagas, vagas: 0, blockedReason: "conferir", motivos });

    // Sem id a caixa não é reservável, mas a consulta (e a demanda) continua registrada.
    if (c.ctoId === null) {
      ctos.push(conferir(["cto_sem_id"]));
      continue;
    }
    const detail = await network.getCtoVagas(c.ctoId);
    // Sem caixa no OLTCloud (ou caixa recriada com outro id): é "conferir", não "CTO sumiu".
    if (!detail) {
      ctos.push(conferir(["sem_caixa_oltcloud"]));
      continue;
    }

    // O mapa (Codemaps) é a base das vagas; a Wiki já descontou o excesso do OLTCloud. Vaga
    // livre acima do que o mapa informa seria inconsistente. Mapa sem contagem não prova nada.
    const portalMotivos: string[] = [];
    if (c.freePorts === null) portalMotivos.push("mapa_sem_contagem");
    else if (detail.vagasLivres > c.freePorts) portalMotivos.push("vagas_acima_do_mapa");
    if (isStale(detail.updatedAt)) portalMotivos.push("dado_antigo");
    const motivos = [...detail.motivos, ...portalMotivos];

    if (detail.confidence === "conferir" || portalMotivos.length > 0) {
      ctos.push(conferir(motivos.length ? motivos : ["fonte_marcou_conferir"], detail.totalVagas));
      continue;
    }
    const livres = Math.max(0, detail.vagasLivres - (reserved.get(c.ctoId) ?? 0));
    let blockedReason: ViabilityCto["blockedReason"] = livres === 0 ? "sem_vaga_livre" : null;
    if (!blockedReason && partner) {
      const used = usage.get(c.ctoId) ?? 0;
      if (used + 1 > maxVagasForPartner(detail.totalVagas, partner.maxCtoOccupancyPct)) blockedReason = "limite_ocupacao";
    }
    // Motivos informativos (não bloqueiam) seguem para a Speed.
    ctos.push({ ...base, totalVagas: detail.totalVagas, vagas: blockedReason ? 0 : livres, blockedReason, motivos: detail.motivos });
  }

  const viable = ctos.some((c) => c.blockedReason === null);
  const activePlans = viable
    ? await db
        .select({ id: plans.id, name: plans.name, speedMbps: plans.speedMbps })
        .from(plans)
        .where(eq(plans.active, true))
        .orderBy(plans.speedMbps)
    : [];

  const reason = viable ? null : foraDaArea ? "fora_da_area" : ctos.length === 0 ? "nenhuma_cto_no_raio" : "sem_vaga_disponivel";
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
        ctos: ctos.map((c) => ({ ctoId: c.ctoId, name: c.name, regiao: c.regiao, vagas: c.vagas, blocked: c.blockedReason, ambiguous: c.proximaAmbigua, motivos: c.motivos })),
        // Contagem do mapa, para a Speed entender por que uma CTO ficou em "conferir".
        sources: candidates.map((c) => ({ ctoId: c.ctoId, mapFree: c.freePorts })),
        // CTOs perto do endereço que ficaram fora da área liberada (demanda fora do piloto).
        foraDaAreaCount: nearby.ctos.length - inArea.length,
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
  return { queryId: saved!.id, viable, foraDaArea, point: nearby.point, ctos: visible, plans: activePlans };
}
