import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contractIssues } from "./contracts.js";
import { activations, customerOperations, partners, plans, portReservations, tickets } from "../db/schema.js";

/** Quantos chamados do mesmo parceiro na mesma CTO, em quantos dias, acendem o alerta (planejamento: "muitos chamados na mesma CTO"). */
export const HOTSPOT_MIN_TICKETS = 3;
export const HOTSPOT_DAYS = 30;

const FINAL = ["resolvido", "cancelado"];

export interface Hotspot {
  partnerId: string;
  partnerName: string;
  ctoId: string;
  ctoName: string | null;
  total: number;
  abertos: number;
  ultimoEm: Date;
}

/** CTOs em que um mesmo parceiro abriu muitos chamados no período: indica problema de infraestrutura ou instalação malfeita. */
export async function ticketHotspots(db: Db, opts: { min?: number; days?: number; now?: Date } = {}): Promise<Hotspot[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? HOTSPOT_DAYS) * 24 * 3600_000);
  const rows = await db
    .select({ partnerId: tickets.partnerId, partnerName: partners.name, ctoId: tickets.ctoId, ctoName: tickets.ctoName, state: tickets.state, createdAt: tickets.createdAt })
    .from(tickets)
    .innerJoin(partners, eq(partners.id, tickets.partnerId))
    .where(and(isNotNull(tickets.ctoId), gte(tickets.createdAt, since)));
  const by = new Map<string, Hotspot>();
  for (const r of rows) {
    const key = `${r.partnerId}|${r.ctoId}`;
    const cur = by.get(key) ?? { partnerId: r.partnerId, partnerName: r.partnerName, ctoId: r.ctoId!, ctoName: r.ctoName, total: 0, abertos: 0, ultimoEm: r.createdAt };
    cur.total += 1;
    if (!FINAL.includes(r.state)) cur.abertos += 1;
    if (r.createdAt > cur.ultimoEm) cur.ultimoEm = r.createdAt;
    by.set(key, cur);
  }
  return [...by.values()].filter((h) => h.total >= (opts.min ?? HOTSPOT_MIN_TICKETS)).sort((a, b) => b.total - a.total || b.ultimoEm.getTime() - a.ultimoEm.getTime());
}

export interface PartnerOverview {
  partnerId: string;
  name: string;
  code: string | null;
  status: string;
  portasAtivas: number;
  bloqueados: number;
  reservasAbertas: number;
  /** O que a Speed recebe por mês desse parceiro: soma do valor fixo por porta ativa, dos planos de cada uma. */
  receitaMensalCents: number;
  chamadosAbertos: number;
  chamadosAtrasados: number;
  foraDoPadrao: number;
}

export interface OutOfStandard {
  reservationId: string;
  partnerName: string;
  contract: string | null;
  ctoName: string;
  sinalCtoDbm: number;
  sinalFinalDbm: number;
  minimoDbm: number;
  /** Quanto abaixo do mínimo aceitável (dB, positivo). */
  excessoDb: number;
}

/**
 * Visão consolidada da Speed (planejamento): portas ocupadas e receita por parceiro, chamados abertos e instalações fora
 * do padrão de sinal. Porta ativa = reserva convertida com a O.S. fechada, como no financeiro do parceiro.
 */
export async function speedOverview(db: Db, now = new Date()) {
  const all = await db.select().from(partners);
  const reservations = await db
    .select({ r: portReservations, price: plans.speedPriceCents })
    .from(portReservations)
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(inArray(portReservations.status, ["ativa", "convertida"]));
  const acts = await db
    .select({ reservationId: activations.reservationId, sinalCtoDbm: activations.sinalCtoDbm, limiteDb: activations.limiteDb })
    .from(activations)
    .where(eq(activations.state, "online"));
  const actBy = new Map(acts.map((a) => [a.reservationId, a]));
  const allTickets = await db.select({ partnerId: tickets.partnerId, state: tickets.state, dueAt: tickets.dueAt }).from(tickets);

  const outOf: OutOfStandard[] = [];
  const parceiros: PartnerOverview[] = all.map((p) => {
    const mine = reservations.filter((x) => x.r.partnerId === p.id);
    const ports = mine.filter((x) => x.r.status === "convertida" && x.r.osClosedAt);
    const openT = allTickets.filter((t) => t.partnerId === p.id && !FINAL.includes(t.state));
    let fora = 0;
    for (const x of ports) {
      const os = x.r.osData as { sinalFinalDbm?: number } | null;
      const a = actBy.get(x.r.id);
      if (!os || typeof os.sinalFinalDbm !== "number" || !a) continue;
      const minimo = Number((a.sinalCtoDbm - a.limiteDb).toFixed(2));
      if (os.sinalFinalDbm < minimo) {
        fora += 1;
        outOf.push({ reservationId: x.r.id, partnerName: p.name, contract: x.r.contractNumber, ctoName: x.r.ctoName, sinalCtoDbm: a.sinalCtoDbm, sinalFinalDbm: os.sinalFinalDbm, minimoDbm: minimo, excessoDb: Number((minimo - os.sinalFinalDbm).toFixed(2)) });
      }
    }
    return {
      partnerId: p.id,
      name: p.name,
      code: p.code,
      status: p.status,
      portasAtivas: ports.length,
      bloqueados: ports.filter((x) => x.r.customerStatus === "bloqueado").length,
      reservasAbertas: mine.filter((x) => x.r.status === "ativa").length,
      receitaMensalCents: ports.reduce((s, x) => s + (x.price ?? 0), 0),
      chamadosAbertos: openT.length,
      chamadosAtrasados: openT.filter((t) => t.dueAt < now).length,
      foraDoPadrao: fora,
    };
  });
  parceiros.sort((a, b) => b.portasAtivas - a.portasAtivas || a.name.localeCompare(b.name));

  const hotspots = await ticketHotspots(db, { now });
  const contratos = await contractIssues(db, now);
  const pending = await db.select({ id: customerOperations.id }).from(customerOperations).where(eq(customerOperations.state, "aguardando_aprovacao"));
  return {
    totais: {
      portasAtivas: parceiros.reduce((s, p) => s + p.portasAtivas, 0),
      receitaMensalCents: parceiros.reduce((s, p) => s + p.receitaMensalCents, 0),
      chamadosAbertos: parceiros.reduce((s, p) => s + p.chamadosAbertos, 0),
      chamadosAtrasados: parceiros.reduce((s, p) => s + p.chamadosAtrasados, 0),
      foraDoPadrao: outOf.length,
      aprovacoesPendentes: pending.length,
      contratosComProblema: contratos.length,
    },
    parceiros,
    foraDoPadrao: outOf.sort((a, b) => b.excessoDb - a.excessoDb).slice(0, 20),
    hotspots: hotspots.map((h) => ({ ...h, ultimoEm: h.ultimoEm.toISOString() })),
    contratos,
    hotspotRegra: { minimo: HOTSPOT_MIN_TICKETS, dias: HOTSPOT_DAYS },
  };
}
