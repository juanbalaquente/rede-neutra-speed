import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockClientStatus } from "../src/integrations/mock-client-status.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import type { SignalSeries } from "../src/integrations/types.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { clearSignalQualityCache } from "../src/services/signal-quality.js";
import { setup } from "./helpers.js";

/** Sinal e quedas controlados por contrato, para o ranking e a média ficarem previsíveis. */
class ScriptedStatus extends MockClientStatus {
  readonly script = new Map<string, { values: number[]; quedas: number }>();
  signalCalls = 0;
  override async signal(login: string, partnerCode: string, dias: number): Promise<SignalSeries | null> {
    this.signalCalls++;
    const s = this.script.get(login.replace(/-.*$/, ""));
    if (!s) return super.signal(login, partnerCode, dias);
    const base = Date.now() - s.values.length * 6 * 3600_000;
    return {
      login,
      dias,
      pontos: s.values.map((rxDbm, i) => ({ em: new Date(base + i * 6 * 3600_000).toISOString(), rxDbm })),
      quedas: Array.from({ length: s.quedas }, (_, i) => ({ inicio: new Date(base + i * 24 * 3600_000).toISOString(), fim: null, tipo: "loss" as const })),
    };
  }
}

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let wiki: ScriptedStatus;

beforeEach(async () => {
  clearSignalQualityCache();
  wiki = new ScriptedStatus();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, undefined, undefined, wiki);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

/** Cliente instalado com sinal na CTO de -20 (mínimo aceitável -21,5). */
async function installed(cookie: string, contract: string) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
  expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" })).status).toBe(200);
  return reservation.id as string;
}

const quality = async (cookie: string, q = "") => (await (await ctx.call(cookie, "GET", `/dashboard/sinal${q}`)).json()) as {
  totais: { clientes: number; comLeitura: number; semLeitura: number; mediaBaseDbm: number | null; abaixoDoMinimo: number; quedas: number; comQueda: number };
  maisQuedas: { contract: string; quedas: number; mediaDbm: number }[];
  abaixoDoMinimo: { contract: string; ultimoDbm: number; minimoDbm: number }[];
};

describe("qualidade do sinal da base", () => {
  it("média da base, clientes com mais quedas e quem está abaixo do mínimo aceitável", async () => {
    const { sup, ate } = await partner();
    await installed(ate, "10001");
    await installed(ate, "10002");
    await installed(ate, "10004");
    wiki.script.set("10001", { values: [-20, -20.5, -21], quedas: 3 }); // média -20,5; 3 quedas; último dentro
    wiki.script.set("10002", { values: [-21, -22, -23], quedas: 1 }); // média -22; último -23 < -21,5
    wiki.script.set("10004", { values: [-19, -19, -19], quedas: 0 }); // média -19; sem quedas
    const q = await quality(sup);
    expect(q.totais).toMatchObject({ clientes: 3, comLeitura: 3, semLeitura: 0, mediaBaseDbm: -20.5, abaixoDoMinimo: 1, quedas: 4, comQueda: 2 });
    expect(q.maisQuedas.map((c) => `${c.contract}:${c.quedas}`)).toEqual(["10001:3", "10002:1"]);
    expect(q.abaixoDoMinimo).toEqual([expect.objectContaining({ contract: "10002", ultimoDbm: -23, minimoDbm: -21.5 })]);
  });

  it("cliente sem leitura ou com a Wiki falhando conta como sem leitura, sem derrubar o painel", async () => {
    const { sup, ate } = await partner();
    await installed(ate, "10001");
    await installed(ate, "10002");
    wiki.script.set("10001", { values: [-20, -20], quedas: 0 });
    const original = wiki.signal.bind(wiki);
    wiki.signal = async (login, code, dias) => {
      if (login.startsWith("10002")) throw new Error("wiki fora do ar");
      return original(login, code, dias);
    };
    const q = await quality(sup);
    expect(q.totais).toMatchObject({ clientes: 2, comLeitura: 1, semLeitura: 1, mediaBaseDbm: -20 });
  });

  it("guarda o resultado por 10 min (não chama a Wiki de novo) e respeita o período", async () => {
    const { sup, ate } = await partner();
    await installed(ate, "10001");
    wiki.script.set("10001", { values: [-20], quedas: 0 });
    await quality(sup);
    await quality(sup);
    expect(wiki.signalCalls).toBe(1);
    await quality(sup, "?days=7"); // outro período, outra consulta
    expect(wiki.signalCalls).toBe(2);
    expect((await ctx.call(sup, "GET", "/dashboard/sinal?days=45")).status).toBe(400);
  });

  it("sem clientes não chama a Wiki; só o supervisor vê; um parceiro não mistura o outro", async () => {
    const mine = await partner();
    expect((await quality(mine.sup)).totais).toMatchObject({ clientes: 0, comLeitura: 0, mediaBaseDbm: null });
    expect(wiki.signalCalls).toBe(0);
    expect((await ctx.call(mine.ate, "GET", "/dashboard/sinal")).status).toBe(403);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", "/dashboard/sinal")).status).toBe(403);
    const other = await partner("44444444000144", "OUT");
    await installed(other.ate, "20001");
    wiki.script.set("20001", { values: [-30], quedas: 5 });
    expect((await quality(mine.sup)).totais.clientes).toBe(0);
    expect((await quality(other.sup)).totais).toMatchObject({ clientes: 1, quedas: 5 });
  });

  it("fica desligado sem o serviço de status", async () => {
    const off = await setup(new MockNetworkMap(), new MockActivationService());
    const a = await off.createPartner("A", "33333333000133", { code: "AAA" });
    const res = await off.call(await off.login(a.supervisor), "GET", "/dashboard/sinal");
    expect(res.status).toBe(503);
    await off.close();
  });
});
