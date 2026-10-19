import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, plans } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { monthBounds, monthOf } from "../src/services/finance.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const THIS_MONTH = monthOf(new Date());
const LAST_MONTH = monthOf(new Date(monthBounds(THIS_MONTH).start.getTime() - 24 * 3600_000));
const OS = { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" };

const planByMbps = async (mbps: number) => (await ctx.db.select().from(plans).where(eq(plans.speedMbps, mbps)))[0]!;

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

/** Uma instalação completa: reserva, dados do cliente, ONU online e O.S. fechada. */
async function installed(cookie: string, mbps: number, contract: string) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(cookie, reservation.id, { planId: (await planByMbps(mbps)).id, nickname: `Cliente ${contract}` });
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
  expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(200);
  return reservation.id as string;
}

describe("preços de venda", () => {
  it("só o supervisor define; o atendente não vê; começa sem preço", async () => {
    const { sup, ate } = await partner();
    expect((await ctx.call(ate, "GET", "/prices")).status).toBe(403);
    const list = (await (await ctx.call(sup, "GET", "/prices")).json()).prices;
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ name: "600 Mega", speedPriceCents: 4000, salePriceCents: null });
    const p600 = await planByMbps(600);
    const res = await ctx.call(sup, "PUT", "/prices", { planId: p600.id, priceCents: 9990 });
    expect(res.status).toBe(200);
    expect((await res.json()).prices[0].salePriceCents).toBe(9990);
    expect((await ctx.db.select().from(auditLog)).find((l) => l.action === "preco.alterado")?.data).toMatchObject({ before: null, after: 9990 });
    // Trocar o preço registra o anterior.
    await ctx.call(sup, "PUT", "/prices", { planId: p600.id, priceCents: 10990 });
    const logs = (await ctx.db.select().from(auditLog)).filter((l) => l.action === "preco.alterado");
    expect(logs[1]?.data).toMatchObject({ before: 9990, after: 10990 });
  });

  it("valida plano e valor; um parceiro não vê o preço do outro", async () => {
    const mine = await partner();
    const other = await partner("22222222000122", "OUT");
    const p600 = await planByMbps(600);
    expect((await ctx.call(mine.sup, "PUT", "/prices", { planId: "00000000-0000-4000-8000-000000000000", priceCents: 9990 })).status).toBe(422);
    expect((await ctx.call(mine.sup, "PUT", "/prices", { planId: p600.id, priceCents: 0 })).status).toBe(400);
    expect((await ctx.call(mine.sup, "PUT", "/prices", { planId: p600.id, priceCents: 99.9 })).status).toBe(400);
    await ctx.call(mine.sup, "PUT", "/prices", { planId: p600.id, priceCents: 9990 });
    expect((await (await ctx.call(other.sup, "GET", "/prices")).json()).prices[0].salePriceCents).toBeNull();
  });

  it("a Speed define o valor que cobra por plano, com auditoria; o parceiro não", async () => {
    const { sup } = await partner();
    const adm = await ctx.login("admin@speed.test");
    const p600 = await planByMbps(600);
    expect((await ctx.call(sup, "PATCH", `/admin/plans/${p600.id}`, { speedPriceCents: 4200 })).status).toBe(403);
    expect((await ctx.call(adm, "PATCH", `/admin/plans/${p600.id}`, { speedPriceCents: 4200 })).status).toBe(200);
    expect((await (await ctx.call(sup, "GET", "/prices")).json()).prices[0].speedPriceCents).toBe(4200);
    expect((await ctx.db.select().from(auditLog)).find((l) => l.action === "plano.preco_speed")?.data).toMatchObject({ before: 4000, after: 4200 });
  });
});

describe("financeiro do mês", () => {
  it("custo, faturamento, lucro e margem por plano a partir das portas ativas", async () => {
    const { sup, ate } = await partner();
    await installed(ate, 600, "10001");
    await installed(ate, 1000, "10002");
    await ctx.call(sup, "PUT", "/prices", { planId: (await planByMbps(600)).id, priceCents: 9990 });
    await ctx.call(sup, "PUT", "/prices", { planId: (await planByMbps(1000)).id, priceCents: 13990 });

    const f = await (await ctx.call(sup, "GET", `/finance?month=${THIS_MONTH}`)).json();
    expect(f.resumo).toMatchObject({ portasAtivas: 2, custoCents: 9600, faturamentoCents: 23980, lucroCents: 14380, recebidoCents: 0, emAbertoCents: 23980, semPreco: 0 });
    expect(f.porPlano).toHaveLength(2);
    expect(f.porPlano[0]).toMatchObject({ plan: "600 Mega", qtd: 1, custoCents: 4000, faturamentoCents: 9990, lucroCents: 5990, margemPct: 60 });
    expect(f.clientes.map((c: { contract: string }) => c.contract)).toEqual(["10001", "10002"]);
    // O mês anterior ainda não tinha as portas.
    expect((await (await ctx.call(sup, "GET", `/finance?month=${LAST_MONTH}`)).json()).resumo.portasAtivas).toBe(0);
  });

  it("cliente de plano sem preço cadastrado conta em semPreco e não entra no faturamento", async () => {
    const { sup, ate } = await partner();
    await installed(ate, 600, "10001");
    const f = await (await ctx.call(sup, "GET", `/finance?month=${THIS_MONTH}`)).json();
    expect(f.resumo).toMatchObject({ portasAtivas: 1, custoCents: 4000, faturamentoCents: 0, lucroCents: -4000, semPreco: 1 });
    expect(f.porPlano[0].margemPct).toBeNull();
  });

  it("marca e desmarca o pagamento; recebido e em aberto acompanham", async () => {
    const { sup, ate } = await partner();
    const id = await installed(ate, 600, "10001");
    await ctx.call(sup, "PUT", "/prices", { planId: (await planByMbps(600)).id, priceCents: 9990 });
    expect((await ctx.call(sup, "PUT", "/finance/payments", { reservationId: id, month: THIS_MONTH, paid: true })).status).toBe(200);
    let f = await (await ctx.call(sup, "GET", `/finance?month=${THIS_MONTH}`)).json();
    expect(f.resumo).toMatchObject({ recebidoCents: 9990, emAbertoCents: 0, pagos: 1 });
    expect(f.clientes[0].paid).toBe(true);
    await ctx.call(sup, "PUT", "/finance/payments", { reservationId: id, month: THIS_MONTH, paid: false });
    f = await (await ctx.call(sup, "GET", `/finance?month=${THIS_MONTH}`)).json();
    expect(f.resumo).toMatchObject({ recebidoCents: 0, emAbertoCents: 9990 });
    expect(f.clientes[0].paid).toBe(false);
    expect((await ctx.db.select().from(auditLog)).filter((l) => l.action === "pagamento.marcado")).toHaveLength(2);
    // Mês em que o cliente ainda não existia.
    expect((await ctx.call(sup, "PUT", "/finance/payments", { reservationId: id, month: LAST_MONTH, paid: true })).status).toBe(409);
  });

  it("isolamento e perfis: atendente e Speed não entram; outro parceiro não marca", async () => {
    const mine = await partner();
    const other = await partner("22222222000122", "OUT");
    const id = await installed(mine.ate, 600, "10001");
    expect((await ctx.call(mine.ate, "GET", `/finance?month=${THIS_MONTH}`)).status).toBe(403);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", `/finance?month=${THIS_MONTH}`)).status).toBe(403);
    expect((await ctx.call(other.sup, "PUT", "/finance/payments", { reservationId: id, month: THIS_MONTH, paid: true })).status).toBe(404);
    expect((await (await ctx.call(other.sup, "GET", `/finance?month=${THIS_MONTH}`)).json()).resumo.portasAtivas).toBe(0);
    expect((await ctx.call(mine.sup, "GET", "/finance?month=2026-13")).status).toBe(400);
  });

  it("exporta a planilha (CSV com BOM e ponto e vírgula) e protege o acesso", async () => {
    const { sup, ate } = await partner();
    await installed(ate, 600, "10001");
    await ctx.call(sup, "PUT", "/prices", { planId: (await planByMbps(600)).id, priceCents: 9990 });
    const res = await ctx.call(sup, "GET", `/finance/export?month=${THIS_MONTH}&type=fechamento`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toContain(`fechamento-${THIS_MONTH}.csv`);
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // BOM: o Excel em português reconhece o UTF-8
    const text = await res.text();
    expect(text).toContain("Plano;Portas ativas;Custo Speed (R$);Faturamento previsto (R$);Lucro previsto (R$);Margem");
    expect(text).toContain("600 Mega;1;40,00;99,90;59,90;60%");
    expect(text).toContain("TOTAL;1;40,00;99,90;59,90");
    const clientes = await (await ctx.call(sup, "GET", `/finance/export?month=${THIS_MONTH}&type=clientes`)).text();
    expect(clientes).toContain("10001;Cliente 10001;600 Mega;");
    expect((await ctx.call(sup, "GET", `/finance/export?month=${THIS_MONTH}&type=lixo`)).status).toBe(400);
    expect((await ctx.call(ate, "GET", `/finance/export?month=${THIS_MONTH}`)).status).toBe(403);
  });
});

describe("painel do parceiro", () => {
  it("conta portas ativas, O.S. pendentes, reservas abertas e instalações do mês", async () => {
    const { ate, a } = await partner();
    await installed(ate, 600, "10001");
    // Uma reserva só reservada e outra com a ONU online sem O.S. fechada.
    await ctx.call(ate, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await ctx.call(ate, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    await ctx.setCliente(ate, reservation.id, { visitAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    const d = await (await ctx.call(ate, "GET", "/dashboard")).json();
    expect(d).toMatchObject({ portasAtivas: 1, reservasAbertas: 1, osPendentes: 0, instalacoesNoMes: 1, visitasAtrasadas: 1 });
    expect(d.serie).toHaveLength(6);
    expect(d.serie[5]).toMatchObject({ month: THIS_MONTH, instalacoes: 1, ativasNoFim: 1 });
    expect(d.planos).toEqual([{ plano: "600 Mega", qtd: 1 }]);
    // Outro parceiro não vê nada disso; a Speed tem outro painel.
    const other = await ctx.createPartner("Outro", "33333333000133", { code: "OUT" });
    expect((await (await ctx.call(await ctx.login(other.atendente), "GET", "/dashboard")).json()).portasAtivas).toBe(0);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", "/dashboard")).status).toBe(403);
    void a;
  });
});

describe("filtros dos relatórios", () => {
  async function setupBase() {
    const { sup, ate } = await partner();
    const p600 = await planByMbps(600);
    const p1g = await planByMbps(1000);
    await ctx.call(sup, "PUT", "/prices", { planId: p600.id, priceCents: 9990 });
    await ctx.call(sup, "PUT", "/prices", { planId: p1g.id, priceCents: 13990 });
    const a = await installed(ate, 600, "10001");
    const b = await installed(ate, 600, "10002");
    const c = await installed(ate, 1000, "10003");
    await ctx.call(sup, "PUT", "/finance/payments", { reservationId: a, month: THIS_MONTH, paid: true });
    return { sup, ate, p600, p1g, a, b, c };
  }
  const fin = async (cookie: string, query: string) => (await (await ctx.call(cookie, "GET", `/finance?month=${THIS_MONTH}${query}`)).json()) as { resumo: { portasAtivas: number; custoCents: number; faturamentoCents: number; recebidoCents: number }; porPlano: { plan: string }[]; clientes: { contract: string; ctoName: string }[] };

  it("filtra por plano, e o resumo e o fechamento seguem o filtro", async () => {
    const { sup, p1g } = await setupBase();
    expect((await fin(sup, "")).resumo.portasAtivas).toBe(3);
    const only = await fin(sup, `&planId=${p1g.id}`);
    expect(only.resumo).toMatchObject({ portasAtivas: 1, faturamentoCents: 13990 });
    expect(only.porPlano).toHaveLength(1);
    expect(only.clientes.map((c) => c.contract)).toEqual(["10003"]);
  });

  it("filtra por CTO (id ou parte do nome) e por status de pagamento", async () => {
    const { sup } = await setupBase();
    expect((await fin(sup, "&cto=TESTE-01")).resumo.portasAtivas).toBe(3);
    expect((await fin(sup, "&cto=cto-teste-01")).resumo.portasAtivas).toBe(3); // sem diferenciar maiúsculas
    expect((await fin(sup, "&cto=NAO-EXISTE")).resumo.portasAtivas).toBe(0);
    const paid = await fin(sup, "&status=pago");
    expect(paid.clientes.map((c) => c.contract)).toEqual(["10001"]);
    expect(paid.resumo.recebidoCents).toBe(9990);
    expect((await fin(sup, "&status=em_aberto")).clientes.map((c) => c.contract).sort()).toEqual(["10002", "10003"]);
  });

  it("filtra por situação do contrato (bloqueado) e valida os valores", async () => {
    const { sup, b } = await setupBase();
    const { portReservations } = await import("../src/db/schema.js");
    await ctx.db.update(portReservations).set({ customerStatus: "bloqueado" }).where(eq(portReservations.id, b));
    expect((await fin(sup, "&status=bloqueado")).clientes.map((c) => c.contract)).toEqual(["10002"]);
    expect((await fin(sup, "&status=ativo")).resumo.portasAtivas).toBe(2);
    expect((await ctx.call(sup, "GET", `/finance?month=${THIS_MONTH}&status=qualquer`)).status).toBe(400);
    expect((await ctx.call(sup, "GET", `/finance?month=${THIS_MONTH}&planId=nao-e-uuid`)).status).toBe(400);
  });

  it("a planilha respeita os filtros e traz CTO e situação", async () => {
    const { sup, p600 } = await setupBase();
    const res = await ctx.call(sup, "GET", `/finance/export?month=${THIS_MONTH}&type=clientes&planId=${p600.id}`);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text).toContain("CTO;Situação");
    expect(text).toContain("10001");
    expect(text).toContain("CTO-TESTE-01");
    expect(text).not.toContain("10003");
  });
});

describe("cobrança pelo portal: cliente cancelado", () => {
  it("é cobrado no mês do cancelamento, sai dos meses seguintes e não muda o fechamento dos meses passados", async () => {
    const { sup, ate } = await partner();
    const p600 = await planByMbps(600);
    const a = await installed(ate, 600, "10001");
    const b = await installed(ate, 600, "10002");
    const { portReservations } = await import("../src/db/schema.js");
    // Os dois foram ativados no mês passado.
    const lastStart = monthBounds(LAST_MONTH).start;
    await ctx.db.update(portReservations).set({ osClosedAt: new Date(lastStart.getTime() + 2 * 24 * 3600_000) });
    // b foi cancelado neste mês.
    await ctx.db.update(portReservations).set({ status: "cancelada", customerStatus: "cancelado", cancelledAt: new Date() }).where(eq(portReservations.id, b));
    const fin = async (month: string) => (await (await ctx.call(sup, "GET", `/finance?month=${month}`)).json());
    const last = await fin(LAST_MONTH);
    expect(last.resumo).toMatchObject({ portasAtivas: 2, custoCents: p600.speedPriceCents * 2 }); // o passado não muda
    const now = await fin(THIS_MONTH);
    expect(now.resumo.portasAtivas).toBe(2); // cobrado no mês do cancelamento (mês cheio)
    const cancelled = now.clientes.find((c: { id: string }) => c.id === b);
    expect(cancelled.cancelledAt).toBeTruthy();
    expect(now.clientes.find((c: { id: string }) => c.id === a).cancelledAt).toBeNull();
    // No mês seguinte ao cancelamento, já não cobra.
    const next = monthOf(new Date(monthBounds(THIS_MONTH).end.getTime() + 24 * 3600_000));
    expect((await fin(next)).resumo.portasAtivas).toBe(1);
    // O painel conta a instalação do cliente cancelado na história.
    const dash = await (await ctx.call(sup, "GET", "/dashboard")).json();
    const lastSerie = dash.serie.find((s: { month: string }) => s.month === LAST_MONTH);
    expect(lastSerie).toMatchObject({ instalacoes: 2, ativasNoFim: 2 });
  });
});

describe("cobrança da Speed por parceiro (o parceiro paga por fora do ERP)", () => {
  it("soma por parceiro as portas cobradas no mês × valor fixo, e o demonstrativo lista contrato e login", async () => {
    const a = await partner();
    const b = await partner("22222222000122", "OUT");
    const p600 = await planByMbps(600);
    const p1g = await planByMbps(1000);
    await installed(a.ate, 600, "10001");
    await installed(a.ate, 1000, "10002");
    await installed(b.ate, 600, "20001");
    const adm = await ctx.login("admin@speed.test");
    const res = await ctx.call(adm, "GET", `/admin/cobranca?month=${THIS_MONTH}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const jhv = body.parceiros.find((p: { code: string }) => p.code === "JHV");
    const out = body.parceiros.find((p: { code: string }) => p.code === "OUT");
    expect(jhv).toMatchObject({ portas: 2, valorCents: p600.speedPriceCents + p1g.speedPriceCents, canceladasNoMes: 0 });
    expect(out).toMatchObject({ portas: 1, valorCents: p600.speedPriceCents });
    expect(body).toMatchObject({ totalPortas: 3, totalCents: 2 * p600.speedPriceCents + p1g.speedPriceCents });

    const csvRes = await ctx.call(adm, "GET", `/admin/cobranca/${jhv.partnerId}/export?month=${THIS_MONTH}`);
    expect(csvRes.headers.get("content-disposition")).toContain(`cobranca-JHV-${THIS_MONTH}.csv`);
    const text = new TextDecoder().decode(await csvRes.arrayBuffer());
    expect(text).toContain("Contrato;Login PPPoE;Plano;CTO;Ativado em;Cancelado em;Valor (R$)");
    expect(text).toContain("10001;10001-JHV");
    expect(text).toContain("TOTAL");
    expect(text).not.toContain("20001"); // só o parceiro pedido
  });

  it("só a Speed vê a cobrança", async () => {
    const a = await partner();
    expect((await ctx.call(a.sup, "GET", `/admin/cobranca?month=${THIS_MONTH}`)).status).toBe(403);
  });
});
