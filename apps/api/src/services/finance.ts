import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { partnerPrices, payments, plans, portReservations, settings, tickets, partners, viabilityQueries } from "../db/schema.js";
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
  /** CTO onde a porta está e situação do contrato do assinante (ativo | bloqueado). */
  ctoName: string;
  customerStatus: string;
  /** Cancelado neste mês (ainda cobrado nele) ou null. */
  cancelledAt: Date | null;
  /** null = ainda não marcado neste mês. */
  paid: boolean | null;
}

/** Filtros dos relatórios (planejamento: período, plano, CTO e status). O período é o mês. */
export interface FinanceFilters {
  planId?: string;
  /** Id ou parte do nome da CTO. */
  cto?: string;
  /** ativo | bloqueado (contrato) ou pago | em_aberto (pagamento do mês). */
  status?: "ativo" | "bloqueado" | "pago" | "em_aberto";
}

/** Porta ativa no mês: reserva convertida com a O.S. fechada até o fim do mês. */
export async function getFinance(db: Db, user: SessionUser, month: string, filters: FinanceFilters = {}) {
  return financeForPartner(db, requirePartner(user), month, filters);
}

/** Fechamento de um parceiro no mês. A mesma regra serve ao parceiro (financeiro) e à Speed (cobrança). */
export async function financeForPartner(db: Db, partnerId: string, month: string, filters: FinanceFilters = {}) {
  const { start, end } = monthBounds(month);
  const rows = await db
    .select({ r: portReservations, plan: plans })
    .from(portReservations)
    // leftJoin: instalação anterior à exigência de plano não some do financeiro, vira "Sem plano" e sem custo.
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(and(eq(portReservations.partnerId, partnerId), inArray(portReservations.status, ["convertida", "cancelada"]), isNotNull(portReservations.osClosedAt)));
  const NO_PLAN = { id: "sem-plano", name: "Sem plano", speedMbps: 0, speedPriceCents: 0 };
  const cto = filters.cto?.trim().toLowerCase();
  // Porta cobrada no mês: ativada até o fim dele e não cancelada antes do começo. Mês cheio na ativação e no cancelamento
  // (padrão até a decisão sobre proporcional). O fechamento de um mês passado não muda com cancelamentos posteriores.
  const active = rows
    .filter((x) => x.r.osClosedAt! < end && (x.r.status !== "cancelada" || (x.r.cancelledAt !== null && x.r.cancelledAt >= start)))
    .map((x) => ({ r: x.r, plan: x.plan ?? NO_PLAN }))
    .filter(({ r, plan }) => (!filters.planId || plan.id === filters.planId) && (!cto || r.ctoId.toLowerCase() === cto || r.ctoName.toLowerCase().includes(cto)))
    .filter(({ r }) => filters.status !== "ativo" && filters.status !== "bloqueado" ? true : r.customerStatus === filters.status);
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
      ctoName: r.ctoName,
      customerStatus: r.customerStatus,
      cancelledAt: r.status === "cancelada" ? r.cancelledAt : null,
      paid: paid.get(r.id) ?? null,
    }))
    .filter((c) => (filters.status === "pago" ? c.paid === true : filters.status === "em_aberto" ? c.paid !== true : true))
    .sort((a, b) => a.activatedAt.getTime() - b.activatedAt.getTime());

  const byPlan = new Map<string, { planId: string; plan: string; speedMbps: number; qtd: number; custoCents: number; faturamentoCents: number }>();
  const kept = new Set(clients.map((c) => c.id));
  for (const { r, plan } of active.filter((x) => kept.has(x.r.id))) {
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
      // Porta cobrada no mês inclui a cancelada nele (mês cheio); o painel conta só as ativas agora. Os dois números aparecem juntos.
      ativas: clients.filter((c) => c.cancelledAt === null).length,
      canceladasNoMes: clients.filter((c) => c.cancelledAt !== null).length,
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
    ["Contrato", "Apelido", "Plano", "CTO", "Situação", "Ativado em", "Preço de venda (R$)", "Custo Speed (R$)", "Pago no mês"],
    f.clientes.map((c) => [c.contract, c.nickname, c.plan, c.ctoName, c.customerStatus, c.activatedAt.toISOString().slice(0, 10), brl(c.priceCents), brl(c.costCents), c.paid === null ? "não marcado" : c.paid ? "sim" : "não"]),
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
  // Clientes instalados e depois cancelados: entram na história (instalações do mês e portas ativas no fim de cada mês).
  const gone = await db
    .select({ closedAt: portReservations.osClosedAt, cancelledAt: portReservations.cancelledAt })
    .from(portReservations)
    .where(and(eq(portReservations.partnerId, partnerId), eq(portReservations.status, "cancelada"), isNotNull(portReservations.osClosedAt)));

  // Últimos 12 meses: instalações fechadas em cada um e portas ativas no fim dele (a tela corta os meses vazios do começo).
  const serie = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - (11 - i), 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const { start, end } = monthBounds(month);
    return {
      month,
      instalacoes: closedAt.filter((t) => t >= start && t < end).length + gone.filter((g) => g.closedAt! >= start && g.closedAt! < end).length,
      ativasNoFim: closedAt.filter((t) => t < end).length + gone.filter((g) => g.closedAt! < end && g.cancelledAt !== null && g.cancelledAt >= end).length,
    };
  });

  const planos = new Map<string, number>();
  for (const x of rows.filter((x) => x.r.osClosedAt)) planos.set(x.planName ?? "sem plano", (planos.get(x.planName ?? "sem plano") ?? 0) + 1);

  // Funil dos últimos 30 dias: do endereço consultado à O.S. fechada (reservas canceladas e vencidas contam como reservadas).
  const since = new Date(now.getTime() - 30 * 24 * 3600_000);
  const queries = await db.select({ viable: viabilityQueries.viable }).from(viabilityQueries).where(and(eq(viabilityQueries.partnerId, partnerId), gte(viabilityQueries.createdAt, since)));
  const recent = await db
    .select({ contract: portReservations.contractNumber, closed: portReservations.osClosedAt })
    .from(portReservations)
    .where(and(eq(portReservations.partnerId, partnerId), gte(portReservations.createdAt, since)));
  const funil = {
    consultas: queries.length,
    comVaga: queries.filter((q) => q.viable).length,
    reservas: recent.length,
    contratos: recent.filter((x) => x.contract !== null).length,
    osFechadas: recent.filter((x) => x.closed !== null).length,
  };

  // O que pede ação do parceiro agora, do mais grave ao menos grave. Cada item leva à tela onde se resolve.
  const who = (x: (typeof rows)[number]) => x.r.nickname ?? x.r.contractNumber ?? x.r.address;
  const soon = new Date(now.getTime() + 6 * 3600_000);
  const agora: { id: string; tone: "bad" | "warn"; label: string; text: string; go: "agenda" | "reservas" | "chamados" | "instalacoes"; reservationId?: string }[] = [
    ...rows
      .filter((x) => open(x) && x.r.visitAt && x.r.visitAt < dayStart)
      .sort((a, b) => a.r.visitAt!.getTime() - b.r.visitAt!.getTime())
      .slice(0, 5)
      .map((x) => ({ id: `visita-${x.r.id}`, tone: "bad" as const, label: "Visita atrasada", text: who(x), go: "agenda" as const, reservationId: x.r.id })),
    ...(stillOpen.filter((t) => t.dueAt < now).length > 0
      ? [{ id: "chamados", tone: "bad" as const, label: "Chamado fora do prazo", text: `${stillOpen.filter((t) => t.dueAt < now).length} chamado(s) passaram do prazo da Speed`, go: "chamados" as const }]
      : []),
    ...rows
      .filter((x) => x.r.status === "ativa" && x.r.expiresAt && x.r.expiresAt > now && x.r.expiresAt < soon)
      .sort((a, b) => a.r.expiresAt!.getTime() - b.r.expiresAt!.getTime())
      .slice(0, 5)
      .map((x) => ({ id: `reserva-${x.r.id}`, tone: "warn" as const, label: "Reserva vence em breve", text: `${who(x)} · ${x.r.ctoName}`, go: "reservas" as const, reservationId: x.r.id })),
    ...rows
      .filter((x) => x.r.status === "convertida" && open(x) && !(x.r.visitAt && x.r.visitAt < dayStart))
      .slice(0, 5)
      .map((x) => ({ id: `os-${x.r.id}`, tone: "warn" as const, label: "O.S. para fechar", text: who(x), go: "instalacoes" as const, reservationId: x.r.id })),
  ];

  return {
    agora,
    funil,
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

// ── Cobrança da Speed (o contrato no Voalle não tem valor: o parceiro paga direto à Speed, por este fechamento) ──

export interface PartnerBilling {
  partnerId: string;
  name: string;
  code: string | null;
  cnpj: string;
  status: string;
  portas: number;
  canceladasNoMes: number;
  valorCents: number;
}

/** Quanto cada parceiro deve à Speed no mês: portas ativas em algum momento do mês × valor fixo do plano. */
export async function speedBilling(db: Db, month: string): Promise<{ month: string; parceiros: PartnerBilling[]; totalCents: number; totalPortas: number }> {
  const all = await db.select().from(partners).orderBy(partners.name);
  const parceiros: PartnerBilling[] = [];
  for (const p of all) {
    const f = await financeForPartner(db, p.id, month);
    parceiros.push({
      partnerId: p.id,
      name: p.name,
      code: p.code,
      cnpj: p.cnpj,
      status: p.status,
      portas: f.resumo.portasAtivas,
      canceladasNoMes: f.clientes.filter((c) => c.cancelledAt !== null).length,
      valorCents: f.resumo.custoCents,
    });
  }
  return { month, parceiros, totalCents: parceiros.reduce((s, p) => s + p.valorCents, 0), totalPortas: parceiros.reduce((s, p) => s + p.portas, 0) };
}

// ── Receita da Speed ao longo dos meses e meta (parâmetro da diretoria) ──────

export const REVENUE_GOAL_KEY = "meta.receita_mensal";

/** Meta mensal de receita em centavos; null enquanto a diretoria não definir. */
export async function getRevenueGoal(db: Db): Promise<number | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, REVENUE_GOAL_KEY));
  const cents = (row?.value as { cents?: unknown } | undefined)?.cents;
  return typeof cents === "number" && cents > 0 ? cents : null;
}

export async function setRevenueGoal(db: Db, user: SessionUser, cents: number | null, ip?: string | null) {
  const before = await getRevenueGoal(db);
  await db
    .insert(settings)
    .values({ key: REVENUE_GOAL_KEY, value: { cents }, updatedBy: user.id })
    .onConflictDoUpdate({ target: settings.key, set: { value: { cents }, updatedBy: user.id, updatedAt: new Date() } });
  await recordAudit(db, { partnerId: null, userId: user.id, action: "config.meta_receita", entity: "setting", entityId: REVENUE_GOAL_KEY, ip, data: { before, after: cents } });
  return cents;
}

/** Cobrança dos últimos `count` meses (o mais antigo primeiro), total e por parceiro, para o gráfico e o ranking da Speed. */
export async function speedRevenueSeries(db: Db, now = new Date(), count = 6) {
  const local = new Date(now.getTime() - 3 * 3600_000);
  const months = Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - (count - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const billings: Awaited<ReturnType<typeof speedBilling>>[] = [];
  for (const m of months) billings.push(await speedBilling(db, m));
  const ids = new Map<string, string>();
  for (const b of billings) for (const p of b.parceiros) ids.set(p.partnerId, p.name);
  return {
    metaCents: await getRevenueGoal(db),
    meses: months.map((month, i) => ({ month, totalCents: billings[i]!.totalCents, portas: billings[i]!.totalPortas })),
    parceiros: [...ids.entries()].map(([partnerId, name]) => ({
      partnerId,
      name,
      portas: billings.map((b) => b.parceiros.find((p) => p.partnerId === partnerId)?.portas ?? 0),
      valorCents: billings.map((b) => b.parceiros.find((p) => p.partnerId === partnerId)?.valorCents ?? 0),
    })),
  };
}

/** Demonstrativo de cobrança de um parceiro: uma linha por porta cobrada no mês, para mandar junto da cobrança. */
export function cobrancaCsv(partner: { name: string; code: string | null; cnpj: string }, f: Awaited<ReturnType<typeof financeForPartner>>): string {
  const rows: unknown[][] = f.clientes.map((c) => [
    c.contract,
    c.contract && partner.code ? `${c.contract}-${partner.code}` : "",
    c.plan,
    c.ctoName,
    c.activatedAt.toISOString().slice(0, 10),
    c.cancelledAt ? c.cancelledAt.toISOString().slice(0, 10) : "",
    brl(c.costCents),
  ]);
  rows.push([], ["TOTAL", "", "", "", "", `${f.resumo.portasAtivas} porta(s)`, brl(f.resumo.custoCents)]);
  rows.push([], [`Parceiro: ${partner.name} (CNPJ ${partner.cnpj})`], [`Mês: ${f.month}`], ["Regra: porta ativa em algum momento do mês, mês cheio; valor fixo por plano. O contrato no Voalle não tem valor."]);
  return csv(["Contrato", "Login PPPoE", "Plano", "CTO", "Ativado em", "Cancelado em", "Valor (R$)"], rows);
}
