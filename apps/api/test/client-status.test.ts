import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockClientStatus } from "../src/integrations/mock-client-status.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let wiki: MockClientStatus;

beforeEach(async () => {
  wiki = new MockClientStatus();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, undefined, undefined, wiki);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
let addrSeq = 0;
const OS = { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" };

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

/** Reserva com ONU online (e, se pedido, O.S. fechada). */
async function client(cookie: string, contract: string, closeOs = true) {
  const addr = `${ADDRESS} ${++addrSeq}`; // endereço novo a cada reserva: o mesmo endereço na mesma CTO é barrado
  await ctx.call(cookie, "POST", "/viability", { address: addr });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: addr })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  if (closeOs) {
    for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
    expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(200);
  }
  return reservation.id as string;
}

describe("semáforo do cliente", () => {
  it("mostra fibra, PPPoE e contrato, com a ONU, e a referência de sinal da instalação", async () => {
    const { ate } = await partner();
    const id = await client(ate, "10001");
    const res = await ctx.call(ate, "GET", `/installations/${id}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toMatchObject({
      login: "10001-JHV",
      fibra: { estado: "online" },
      autenticacao: { estado: "conectado" },
      contrato: { estado: "ativo" },
      onu: { modelo: "F670L", vlan: 2500 },
    });
    expect(body.status.fibra.sinalDbm).toBeLessThan(0);
    expect(body).toMatchObject({ fibraVelha: false, pppoeVelho: false });
    // A referência vem da medição do técnico na CTO e do limite que valeu na ativação: o mínimo aceitável.
    expect(body.referencia).toMatchObject({ sinalCtoDbm: -20, limiteDb: 1.5, minimoDbm: -21.5 });
    expect(wiki.calls).toContain("status:10001-JHV");
  });

  it("cada cenário acende o semáforo certo", async () => {
    const { ate } = await partner();
    const loss = await client(ate, "10003");
    const off = await client(ate, "10007");
    const blocked = await client(ate, "10009");
    const read = async (id: string) => (await (await ctx.call(ate, "GET", `/installations/${id}/status`)).json()).status;
    expect(await read(loss)).toMatchObject({ fibra: { estado: "loss", sinalDbm: null }, autenticacao: { estado: "desconectado" } });
    expect(await read(off)).toMatchObject({ fibra: { estado: "offline" } });
    expect(await read(blocked)).toMatchObject({ fibra: { estado: "online" }, contrato: { estado: "bloqueado" } });
  });

  it("'consultar de novo' pede ao vivo, e dado velho é sinalizado", async () => {
    const { ate } = await partner();
    const id = await client(ate, "10001");
    await ctx.call(ate, "GET", `/installations/${id}/status?fresh=true`);
    expect(wiki.calls).toContain("status:10001-JHV:fresh");
    const { getClientStatus } = await import("../src/services/client-status.js");
    const user = { id: "x", role: "atendente", partnerId: (await (await ctx.call(ate, "GET", "/auth/me")).json()).user.partnerId } as never;
    const later = await getClientStatus(ctx.db, wiki, user, id, { now: Date.now() + 60 * 60_000 });
    expect(later).toMatchObject({ fibraVelha: true, pppoeVelho: true });
  });

  it("sem login (ONU não liberada) é 409; a rede não conhecer o login é 404; Wiki fora do ar é 502", async () => {
    const { ate } = await partner();
    await ctx.call(ate, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await ctx.call(ate, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    expect((await ctx.call(ate, "GET", `/installations/${reservation.id}/status`)).status).toBe(409);
    const id = await client(ate, "10001");
    wiki.failNext = true;
    const down = await ctx.call(ate, "GET", `/installations/${id}/status`);
    expect(down.status).toBe(502);
    expect((await down.json()).error).toBe("status_indisponivel");
    expect((await ctx.call(ate, "GET", `/installations/${id}/status`)).status).toBe(200); // volta sozinho
  });

  it("fica desligado sem o serviço", async () => {
    const off = await setup(new MockNetworkMap(), new MockActivationService());
    const a = await off.createPartner("A", "33333333000133", { code: "AAA" });
    const cookie = await off.login(a.atendente);
    const res = await off.call(cookie, "GET", `/installations/${crypto.randomUUID()}/status`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("status_desligado");
    await off.close();
  });
});

describe("sinal de 30 dias", () => {
  it("devolve a série e as quedas, e recusa período fora de 7, 30 e 90", async () => {
    const { ate } = await partner();
    const id = await client(ate, "10001");
    const res = await ctx.call(ate, "GET", `/installations/${id}/signal?days=30`);
    expect(res.status).toBe(200);
    const { series, referencia } = await res.json();
    expect(series.dias).toBe(30);
    expect(series.pontos).toHaveLength(30 * 4 + 1); // uma leitura a cada 6 h
    expect(series.pontos.every((p: { rxDbm: number }) => p.rxDbm < -15 && p.rxDbm > -30)).toBe(true);
    expect(series.quedas).toHaveLength(1);
    expect(referencia.minimoDbm).toBe(-21.5);
    expect((await (await ctx.call(ate, "GET", `/installations/${id}/signal?days=7`)).json()).series.quedas).toHaveLength(0);
    expect((await ctx.call(ate, "GET", `/installations/${id}/signal?days=45`)).status).toBe(400);
  });
});

describe("isolamento", () => {
  it("outro parceiro recebe 404, nunca 403, e a Wiki nem é consultada", async () => {
    const mine = await partner();
    const id = await client(mine.ate, "10001");
    const other = await partner("44444444000144", "OUT");
    const before = wiki.calls.length;
    expect((await ctx.call(other.ate, "GET", `/installations/${id}/status`)).status).toBe(404);
    expect((await ctx.call(other.ate, "GET", `/installations/${id}/signal?days=30`)).status).toBe(404);
    expect(wiki.calls).toHaveLength(before);
  });

  it("a Speed consulta o status de qualquer parceiro, com o código certo", async () => {
    const mine = await partner();
    const id = await client(mine.ate, "10001");
    const adm = await ctx.login("admin@speed.test");
    const res = await ctx.call(adm, "GET", `/installations/${id}/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).status.login).toBe("10001-JHV");
  });
});

describe("painel: fibra online e PPPoE conectado", () => {
  it("conta só portas ativas, separa o que está em alarme e não alarma cliente bloqueado", async () => {
    const { ate, sup } = await partner();
    await client(ate, "10001");
    await client(ate, "10003"); // loss
    await client(ate, "10007"); // offline
    await client(ate, "10009"); // bloqueado: PPPoE caído é esperado
    await client(ate, "10011", false); // O.S. aberta: ainda não é porta ativa
    const res = await ctx.call(sup, "GET", "/dashboard/rede");
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d).toMatchObject({ total: 4, fibraOnline: 2, pppoeConectado: 1, loss: 1, offline: 1, bloqueados: 1, semDados: 0 });
    expect(d.alarmes.map((a: { contract: string; motivo: string }) => `${a.contract}:${a.motivo}`).sort()).toEqual(["10003:fibra_loss", "10007:fibra_offline"]);
    expect(d.atualizadoEm).toBeTruthy();
    expect(wiki.calls.filter((c) => c.startsWith("summary"))).toEqual(["summary:4"]);
  });

  it("sem clientes ativos não chama a Wiki; só o parceiro vê; falha vira 502", async () => {
    const { ate } = await partner();
    const empty = await (await ctx.call(ate, "GET", "/dashboard/rede")).json();
    expect(empty).toMatchObject({ total: 0, alarmes: [] });
    expect(wiki.calls).toHaveLength(0);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", "/dashboard/rede")).status).toBe(403);
    await client(ate, "10001");
    wiki.failNext = true;
    expect((await ctx.call(ate, "GET", "/dashboard/rede")).status).toBe(502);
  });

  it("não mistura clientes de outro parceiro", async () => {
    const mine = await partner();
    const other = await partner("44444444000144", "OUT");
    await client(mine.ate, "10001");
    await client(other.ate, "20003");
    const d = await (await ctx.call(mine.ate, "GET", "/dashboard/rede")).json();
    expect(d).toMatchObject({ total: 1, loss: 0 });
    expect(wiki.calls).toContain("summary:1");
  });
});
