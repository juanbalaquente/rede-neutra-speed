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
