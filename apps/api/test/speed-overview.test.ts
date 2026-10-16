import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, plans, portReservations, tickets } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { MockTicketService } from "../src/integrations/mock-tickets.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, undefined, new MockTicketService());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

async function partner(name: string, cnpj: string, code: string) {
  const a = await ctx.createPartner(name, cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { cookie: await ctx.login(a.atendente), sup: await ctx.login(a.supervisor), id: a.partner.id as string };
}

/** Cliente instalado (O.S. fechada) com o sinal final informado. */
async function installed(cookie: string, contract: string, sinalFinal: number) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
  const res = await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, { sinalFinalDbm: sinalFinal, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" });
  expect(res.status).toBe(200);
  return reservation.id as string;
}

const overview = async () => (await (await ctx.call(await ctx.login("admin@speed.test"), "GET", "/admin/painel/parceiros")).json()) as {
  totais: Record<string, number>;
  parceiros: { name: string; portasAtivas: number; receitaMensalCents: number; chamadosAbertos: number; chamadosAtrasados: number; foraDoPadrao: number; reservasAbertas: number }[];
  foraDoPadrao: { contract: string; partnerName: string; sinalFinalDbm: number; minimoDbm: number; excessoDb: number }[];
  hotspots: { partnerName: string; ctoId: string; total: number }[];
};

describe("painel da Speed por parceiro", () => {
  it("soma portas ativas, receita (valor fixo por plano), reservas e chamados de cada parceiro", async () => {
    const a = await partner("JHV Telecom", "11111111000111", "JHV");
    const b = await partner("Outro Provedor", "22222222000122", "OUT");
    await installed(a.cookie, "10001", -20.5);
    await installed(a.cookie, "10002", -20.8);
    await ctx.call(b.cookie, "POST", "/viability", { address: ADDRESS });
    await ctx.call(b.cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS });
    await ctx.call(a.cookie, "POST", "/tickets", { type: "cto_com_problema", description: "Caixa aberta e bagunçada." });

    const [plan] = await ctx.db.select().from(plans).where(eq(plans.id, (await ctx.db.select().from(portReservations))[0]!.planId!));
    const o = await overview();
    const ja = o.parceiros.find((p) => p.name === "JHV Telecom")!;
    const ou = o.parceiros.find((p) => p.name === "Outro Provedor")!;
    expect(ja).toMatchObject({ portasAtivas: 2, chamadosAbertos: 1, chamadosAtrasados: 0, foraDoPadrao: 0 });
    expect(ja.receitaMensalCents).toBe(plan!.speedPriceCents * 2);
    expect(ou).toMatchObject({ portasAtivas: 0, reservasAbertas: 1, receitaMensalCents: 0 });
    expect(o.totais).toMatchObject({ portasAtivas: 2, chamadosAbertos: 1 });
    expect(o.parceiros[0]!.name).toBe("JHV Telecom"); // mais portas primeiro
  });

  it("lista instalações fora do padrão de sinal: final abaixo do medido na CTO menos o limite", async () => {
    const a = await partner("JHV Telecom", "11111111000111", "JHV");
    await installed(a.cookie, "10001", -20.5); // mínimo -21,5: dentro
    await installed(a.cookie, "10002", -24); // 2,5 dB abaixo do mínimo
    const o = await overview();
    expect(o.parceiros[0]!.foraDoPadrao).toBe(1);
    expect(o.foraDoPadrao).toHaveLength(1);
    expect(o.foraDoPadrao[0]).toMatchObject({ contract: "10002", partnerName: "JHV Telecom", sinalFinalDbm: -24, minimoDbm: -21.5, excessoDb: 2.5 });
  });

  it("só o administrador Speed vê", async () => {
    const a = await partner("JHV Telecom", "11111111000111", "JHV");
    expect((await ctx.call(a.sup, "GET", "/admin/painel/parceiros")).status).toBe(403);
    expect((await ctx.call(a.cookie, "GET", "/admin/painel/parceiros")).status).toBe(403);
  });
});

describe("muitos chamados do mesmo parceiro na mesma CTO", () => {
  const open = (cookie: string, rid: string) => ctx.call(cookie, "POST", "/tickets", { type: "porta_off", description: "Porta ficou OFF de novo.", reservationId: rid });

  it("a partir de 3 chamados em 30 dias a CTO vira alerta e a auditoria registra uma vez", async () => {
    const a = await partner("JHV Telecom", "11111111000111", "JHV");
    const rid = await installed(a.cookie, "10001", -20.5);
    await open(a.cookie, rid);
    await open(a.cookie, rid);
    expect((await overview()).hotspots).toHaveLength(0);
    await open(a.cookie, rid);
    let o = await overview();
    expect(o.hotspots).toHaveLength(1);
    expect(o.hotspots[0]).toMatchObject({ partnerName: "JHV Telecom", ctoId: "CTO-TESTE-01", total: 3 });
    await open(a.cookie, rid);
    o = await overview();
    expect(o.hotspots[0]!.total).toBe(4);
    const alerts = (await ctx.db.select().from(auditLog)).filter((l) => l.action === "chamado.muitos_na_cto");
    expect(alerts).toHaveLength(1); // só no momento em que cruza o limite
  });

  it("chamados antigos (mais de 30 dias) e de outro parceiro não contam", async () => {
    const a = await partner("JHV Telecom", "11111111000111", "JHV");
    const b = await partner("Outro Provedor", "22222222000122", "OUT");
    const ra = await installed(a.cookie, "10001", -20.5);
    await open(a.cookie, ra);
    await open(a.cookie, ra);
    const rb = await installed(b.cookie, "20001", -20.5);
    await open(b.cookie, rb);
    await open(b.cookie, rb);
    expect((await overview()).hotspots).toHaveLength(0); // 2 + 2, não 4 juntos
    await open(a.cookie, ra);
    await ctx.db.update(tickets).set({ createdAt: new Date(Date.now() - 40 * 24 * 3600_000) }).where(eq(tickets.partnerId, a.id));
    expect((await overview()).hotspots).toHaveLength(0);
  });
});
