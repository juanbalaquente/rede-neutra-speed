import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { partnerPrices, payments, plans, portReservations, tickets } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";

/** Brasil não tem horário de verão desde 2019: o mês fecha à meia-noite de -03:00. */
const TZ = "-03:00";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthBounds(month: string): { start: Date; end: Date } {
  if (!MONTH_RE.test(month)) throw new AppError(400, "dados_invalidos", "month: use AAAA-MM.");
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: new Date(`${month}-01T00:00:00${TZ}`), end: new Date(`${next}-01T00:00:00${TZ}`) };
}

export const monthOf = (d: Date) => {
  const local = new Date(d.getTime() - 3 * 3600_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
};

function requirePartner(user: SessionUser): string {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro têm financeiro.");
  return user.partnerId;
}

// ── Preços de venda ──────────────────────────────────────────────────────────

/** Planos com o valor que a Speed cobra (fixo) e o preço de venda do parceiro (null = ainda não cadastrou). */
export async function getPrices(db: Db, user: SessionUser) {
  const partnerId = requirePartner(user);
  const list = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.speedMbps);
  const mine = await db.select().from(partnerPrices).where(eq(partnerPrices.partnerId, partnerId));
  const byPlan = new Map(mine.map((p) => [p.planId, p.priceCents]));
  return list.map((p) => ({ planId: p.id, name: p.name, speedMbps: p.speedMbps, speedPriceCents: p.speedPriceCents, salePriceCents: byPlan.get(p.id) ?? null }));
}

export async function setPrice(db: Db, user: SessionUser, planId: string, priceCents: number, ip?: string | null) {
  const partnerId = requirePartner(user);
  const [plan] = await db.select({ id: plans.id }).from(plans).where(and(eq(plans.id, planId), eq(plans.active, true)));
  if (!plan) throw new AppError(422, "plano_invalido", "Escolha um dos planos disponíveis.");
  const [before] = await db.select({ p: partnerPrices.priceCents }).from(partnerPrices).where(and(eq(partnerPrices.partnerId, partnerId), eq(partnerPrices.planId, planId)));
  await db
    .insert(partnerPrices)
    .values({ partnerId, planId, priceCents, updatedBy: user.id })
    .onConflictDoUpdate({ target: [partnerPrices.partnerId, partnerPrices.planId], set: { priceCents, updatedBy: user.id, updatedAt: new Date() } });
  await recordAudit(db, { partnerId, userId: user.id, action: "preco.alterado", entity: "plan", entityId: planId, ip, data: { before: before?.p ?? null, after: priceCents } });
}

// ── Financeiro do mês ────────────────────────────────────────────────────────

export interface FinanceClient {
  id: string;
  contract: string | null;
  nickname: string | null;
  plan: string;
  planId: string;
  /** Preço de venda do parceiro; null se ele ainda não cadastrou o preço desse plano. */
  priceCents: number | null;
  costCents: number;
  activatedAt: Date;
  /** null = ainda não marcado neste mês. */
  paid: boolean | null;
}

/** Porta ativa no mês: reserva convertida com a O.S. fechada até o fim do mês. */
export async function getFinance(db: Db, user: SessionUser, month: string) {
  const partnerId = requirePartner(user);
  const { end } = monthBounds(month);
  const rows = await db
    .select({ r: portReservations, plan: plans })
    .from(portReservations)
    // leftJoin: instalação anterior à exigência de plano não some do financeiro, vira "Sem plano" e sem custo.
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(and(eq(portReservations.partnerId, partnerId), eq(portReservations.status, "convertida"), isNotNull(portReservations.osClosedAt)));
  const NO_PLAN = { id: "sem-plano", name: "Sem plano", speedMbps: 0, speedPriceCents: 0 };
  const active = rows.filter((x) => x.r.osClosedAt! < end).map((x) => ({ r: x.r, plan: x.plan ?? NO_PLAN }));
  const ids = active.map((x) => x.r.id);
  const priceRows = await db.select().from(partnerPrices).where(eq(partnerPrices.partnerId, partnerId));
  const price = new Map(priceRows.map((p) => [p.planId, p.priceCents]));
  const paidRows = ids.length ? await db.select().from(payments).where(and(inArray(payments.reservationId, ids), eq(payments.month, month))) : [];
  const paid = new Map(paidRows.map((p) => [p.reservationId, p.paid]));

  const clients: FinanceClient[] = active
    .map(({ r, plan }) => ({
      id: r.id,
      contract: r.contractNumber,
      nickname: r.nickname,
      plan: plan.name,
      planId: plan.id,
      priceCents: price.get(plan.id) ?? null,
      costCents: plan.speedPriceCents,
      activatedAt: r.osClosedAt!,
      paid: paid.get(r.id) ?? null,
    }))
    .sort((a, b) => a.activatedAt.getTime() - b.activatedAt.getTime());

  const byPlan = new Map<string, { planId: string; plan: string; speedMbps: number; qtd: number; custoCents: number; faturamentoCents: number }>();
  for (const { r, plan } of active) {
    const row = byPlan.get(plan.id) ?? { planId: plan.id, plan: plan.name, speedMbps: plan.speedMbps, qtd: 0, custoCents: 0, faturamentoCents: 0 };
    row.qtd += 1;
    row.custoCents += plan.speedPriceCents;
    row.faturamentoCents += price.get(plan.id) ?? 0;
    byPlan.set(plan.id, row);
    void r;
  }
  const porPlano = [...byPlan.values()]
    .sort((a, b) => a.speedMbps - b.speedMbps)
    .map((p) => ({ ...p, lucroCents: p.faturamentoCents - p.custoCents, margemPct: p.faturamentoCents > 0 ? Math.round(((p.faturamentoCents - p.custoCents) / p.faturamentoCents) * 1000) / 10 : null }));

  const custoCents = clients.reduce((s, c) => s + c.costCents, 0);
  const faturamentoCents = clients.reduce((s, c) => s + (c.priceCents ?? 0), 0);
  const recebidoCents = clients.reduce((s, c) => s + (c.paid ? (c.priceCents ?? 0) : 0), 0);
  return {
    month,
    resumo: {
      portasAtivas: clients.length,
      custoCents,
      faturamentoCents,
      lucroCents: faturamentoCents - custoCents,
      recebidoCents,
      emAbertoCents: faturamentoCents - recebidoCents,
      pagos: clients.filter((c) => c.paid === true).length,
      semPreco: clients.filter((c) => c.priceCents === null).length,
    },
    porPlano,
    clientes: clients,
  };
}

/** Marca (ou desmarca) o pagamento de um cliente num mês. */
export async function markPayment(db: Db, user: SessionUser, reservationId: string, month: string, paid: boolean, ip?: string | null) {
  const partnerId = requirePartner(user);
  const { end } = monthBounds(month);
  const [r] = await db
    .select({ id: portReservations.id, osClosedAt: portReservations.osClosedAt, contract: portReservations.contractNumber })
    .from(portReservations)
    .where(and(eq(portReservations.id, reservationId), eq(portReservations.partnerId, partnerId)));
  if (!r) throw new AppError(404, "reserva_nao_encontrada", "Cliente não encontrado.");
  if (!r.osClosedAt || r.osClosedAt >= end) throw new AppError(409, "cliente_inativo_no_mes", "Esse cliente ainda não estava ativo nesse mês.");
  await db
    .insert(payments)
    .values({ partnerId, reservationId, month, paid, markedBy: user.id })
    .onConflictDoUpdate({ target: [payments.reservationId, payments.month], set: { paid, markedBy: user.id, markedAt: new Date() } });
  await recordAudit(db, { partnerId, userId: user.id, action: "pagamento.marcado", entity: "port_reservation", entityId: reservationId, ip, data: { month, paid, contract: r.contract } });
}

// ── Exportação (planilha) ────────────────────────────────────────────────────

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const brl = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/** CSV com ponto e vírgula e BOM, que o Excel em português abre direto. */
const csv = (header: string[], rows: unknown[][]) => "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";

export function clientesCsv(f: Awaited<ReturnType<typeof getFinance>>): string {
  return csv(
    ["Contrato", "Apelido", "Plano", "Ativado em", "Preço de venda (R$)", "Custo Speed (R$)", "Pago no mês"],
    f.clientes.map((c) => [c.contract, c.nickname, c.plan, c.activatedAt.toISOString().slice(0, 10), brl(c.priceCents), brl(c.costCents), c.paid === null ? "não marcado" : c.paid ? "sim" : "não"]),
  );
}

/** Fechamento do mês: o documento para conferir contra a fatura da Speed. */
export function fechamentoCsv(f: Awaited<ReturnType<typeof getFinance>>): string {
  const rows: unknown[][] = f.porPlano.map((p) => [p.plan, p.qtd, brl(p.custoCents), brl(p.faturamentoCents), brl(p.lucroCents), p.margemPct === null ? "" : `${p.margemPct}%`]);
  rows.push(["TOTAL", f.resumo.portasAtivas, brl(f.resumo.custoCents), brl(f.resumo.faturamentoCents), brl(f.resumo.lucroCents), ""]);
  rows.push([], ["Recebido", "", "", brl(f.resumo.recebidoCents)], ["Em aberto", "", "", brl(f.resumo.emAbertoCents)]);
  return csv(["Plano", "Portas ativas", "Custo Speed (R$)", "Faturamento previsto (R$)", "Lucro previsto (R$)", "Margem"], rows);
}

// ── Painel operacional do parceiro ───────────────────────────────────────────

export async function getDashboard(db: Db, user: SessionUser, now = new Date()) {
  const partnerId = requirePartner(user);
  const rows = await db
    .select({ r: portReservations, planName: plans.name })
    .from(portReservations)
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(and(eq(portReservations.partnerId, partnerId), inArray(portReservations.status, ["ativa", "convertida"])));
  const today = monthBounds(monthOf(now)); // só para o mês corrente
  const local = new Date(now.getTime() - 3 * 3600_000);
  const dayStart = new Date(`${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}T00:00:00${TZ}`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);

  const openTickets = await db.select({ state: tickets.state, dueAt: tickets.dueAt }).from(tickets).where(eq(tickets.partnerId, partnerId));
  const stillOpen = openTickets.filter((t) => t.state !== "resolvido" && t.state !== "cancelado");

  const open = (x: (typeof rows)[number]) => !x.r.osClosedAt;
  const closedAt = rows.filter((x) => x.r.osClosedAt && x.r.status === "convertida").map((x) => x.r.osClosedAt!);

  // Últimos 6 meses: instalações fechadas em cada um e portas ativas no fim dele.
  const serie = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - (5 - i), 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const { start, end } = monthBounds(month);
    return { month, instalacoes: closedAt.filter((t) => t >= start && t < end).length, ativasNoFim: closedAt.filter((t) => t < end).length };
  });

  const planos = new Map<string, number>();
  for (const x of rows.filter((x) => x.r.osClosedAt)) planos.set(x.planName ?? "sem plano", (planos.get(x.planName ?? "sem plano") ?? 0) + 1);

  return {
    portasAtivas: closedAt.length,
    reservasAbertas: rows.filter((x) => x.r.status === "ativa").length,
    osPendentes: rows.filter((x) => x.r.status === "convertida" && open(x)).length,
    instalacoesNoMes: closedAt.filter((t) => t >= today.start && t < today.end).length,
    visitasHoje: rows.filter((x) => open(x) && x.r.visitAt && x.r.visitAt >= dayStart && x.r.visitAt < dayEnd).length,
    chamadosAbertos: stillOpen.length,
    chamadosAtrasados: stillOpen.filter((t) => t.dueAt < now).length,
    visitasAtrasadas: rows.filter((x) => open(x) && x.r.visitAt && x.r.visitAt < dayStart).length,
    serie,
    planos: [...planos.entries()].map(([plano, qtd]) => ({ plano, qtd })).sort((a, b) => b.qtd - a.qtd),
  };
}

// ── Valor que a Speed cobra por plano (administrador) ────────────────────────

export async function setSpeedPrice(db: Db, user: SessionUser, planId: string, speedPriceCents: number, ip?: string | null) {
  const [before] = await db.select({ p: plans.speedPriceCents, name: plans.name }).from(plans).where(eq(plans.id, planId));
  if (!before) throw new AppError(404, "plano_nao_encontrado", "Plano não encontrado.");
  await db.update(plans).set({ speedPriceCents }).where(eq(plans.id, planId));
  await recordAudit(db, { partnerId: null, userId: user.id, action: "plano.preco_speed", entity: "plan", entityId: planId, ip, data: { plano: before.name, before: before.p, after: speedPriceCents } });
}
