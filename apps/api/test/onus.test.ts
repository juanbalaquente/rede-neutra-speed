import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockClientStatus } from "../src/integrations/mock-client-status.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { diagnose } from "../src/services/onus.js";
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

const ADDRESS = "Rua dos Testes, 200, Belo Horizonte";
let addrSeq = 0;
const OS = { sinalFinalDbm: -21, modeloOnu: "F670L", serialOnu: "ZTEGC0000001" };

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

/** Reserva com ONU online e, se pedido, O.S. fechada. O último dígito do contrato escolhe o cenário do mock. */
async function client(cookie: string, contract: string, closeOs = true) {
  const addr = `${ADDRESS} ${++addrSeq}`;
  await ctx.call(cookie, "POST", "/viability", { address: addr });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: addr })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -22 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  if (closeOs) {
    for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
    expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(200);
  }
  return reservation.id as string;
}

const detail = async (cookie: string, id: string) => {
  const res = await ctx.call(cookie, "GET", `/onus/${id}`);
  expect(res.status).toBe(200);
  return res.json();
};
const codes = (d: { diagnostico: { codigo: string }[] }) => d.diagnostico.map((a) => a.codigo);

describe("lista de ONUs", () => {
  it("traz só as ONUs com O.S. fechada, com estado, sinal e o problema de cada uma", async () => {
    const { ate } = await partner();
    await client(ate, "10001");
    await client(ate, "10003"); // loss
    await client(ate, "10006"); // sinal fraco
    await client(ate, "10009"); // bloqueado: não é problema
    await client(ate, "10011", false); // O.S. aberta: fora da lista
    const res = await ctx.call(ate, "GET", "/onus");
    expect(res.status).toBe(200);
    const { onus, leituraIndisponivel } = await res.json();
    expect(leituraIndisponivel).toBe(false);
    const by = Object.fromEntries(onus.map((o: { contract: string }) => [o.contract, o]));
    expect(Object.keys(by).sort()).toEqual(["10001", "10003", "10006", "10009"]);
    expect(by["10001"]).toMatchObject({ login: "10001-JHV", fibra: "online", autenticacao: "conectado", problema: null, minimoDbm: -23.5, ctoName: expect.any(String) });
    expect(by["10001"].sinalDbm).toBeLessThan(-18);
    expect(by["10003"]).toMatchObject({ fibra: "loss", problema: "sem_luz", sinalDbm: null });
    expect(by["10006"]).toMatchObject({ problema: "sinal_fraco", sinalDbm: -27.4 });
    expect(by["10009"]).toMatchObject({ bloqueado: true, problema: null });
    expect(wiki.calls.filter((c) => c.startsWith("summary"))).toEqual(["summary:4"]);
  });

  it("Wiki fora do ar não some com a lista: os clientes aparecem sem leitura", async () => {
    const { ate } = await partner();
    await client(ate, "10001");
    wiki.failNext = true;
    const { onus, leituraIndisponivel } = await (await ctx.call(ate, "GET", "/onus")).json();
    expect(leituraIndisponivel).toBe(true);
    expect(onus).toHaveLength(1);
    expect(onus[0]).toMatchObject({ contract: "10001", fibra: "desconhecido", problema: null });
  });

  it("não mistura parceiros, é só do parceiro e respeita o modo desligado", async () => {
    const mine = await partner();
    const other = await partner("44444444000144", "OUT");
    await client(mine.ate, "10001");
    await client(other.ate, "20003");
    const { onus } = await (await ctx.call(mine.sup, "GET", "/onus")).json();
    expect(onus.map((o: { login: string }) => o.login)).toEqual(["10001-JHV"]);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "GET", "/onus")).status).toBe(403);

    const off = await setup(new MockNetworkMap(), new MockActivationService());
    const a = await off.createPartner("A", "33333333000133", { code: "AAA" });
    const res = await off.call(await off.login(a.atendente), "GET", "/onus");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("status_desligado");
    await off.close();
  });
});

describe("diagnóstico da ONU", () => {
  it("tudo normal: métricas do OLTCloud, porta da OLT, Wi-Fi e o diagnóstico 'tudo certo'", async () => {
    const { ate } = await partner();
    const id = await client(ate, "10001");
    const d = await detail(ate, id);
    expect(d.cliente).toMatchObject({ contract: "10001", login: "10001-JHV" });
    expect(d.detalhe.onu).toMatchObject({ estado: "online", olt: "OLT_SANTA_INES", slot: 1, pon: 15, txDbm: 2.1 });
    expect(d.detalhe.pon).toMatchObject({ onus: 42, offline: 1 });
    expect(d.detalhe.wifi.dispositivos).toHaveLength(3);
    expect(d.status.autenticacao.estado).toBe("conectado");
    expect(d.detalheProblema).toBeNull();
    expect(codes(d)).toEqual(["tudo_certo"]);
    expect(wiki.calls).toEqual(expect.arrayContaining(["status:10001-JHV:fresh", "onu:10001-JHV"]));
  });

  it("cada cenário dá o diagnóstico certo, na ordem em que o suporte age", async () => {
    const { ate } = await partner();
    const cases: Record<string, string[]> = {
      "10003": ["sem_luz"],
      "10007": ["falha_rede"], // 31 de 42 ONUs da porta fora: não é do cliente
      "10006": ["sinal_fraco"],
      "10004": ["wifi_fraco"],
      "10009": ["bloqueado"],
    };
    for (const [contract, expected] of Object.entries(cases)) {
      const d = await detail(ate, await client(ate, contract));
      expect(codes(d), contract).toEqual(expected);
    }
    const weak = await detail(ate, await client(ate, "10016"));
    expect(weak.diagnostico[0].texto).toMatch(/-27,4 dBm.*-23,5 dBm.*média da porta/);
    const wifi = await detail(ate, await client(ate, "10014"));
    expect(wifi.diagnostico[0].texto).toMatch(/Smart-TV-Sala, iPhone/);
  });

  it("ONU sem roteador no ACS não tem Wi-Fi e nem por isso alarma", async () => {
    const { ate } = await partner();
    const d = await detail(ate, await client(ate, "10008"));
    expect(d.detalhe.wifi).toBeNull();
    expect(codes(d)).toEqual(["tudo_certo"]);
  });

  it("Wiki sem a rota nova: mostra o semáforo e diz que o diagnóstico completo ainda não existe", async () => {
    const { ate } = await partner();
    const id = await client(ate, "10003");
    wiki.onuRouteMissing = true;
    const d = await detail(ate, id);
    expect(d.detalhe).toBeNull();
    expect(d.detalheProblema).toBe("rota_ausente");
    expect(d.status.fibra.estado).toBe("loss");
    expect(codes(d)).toEqual(["sem_luz"]); // o diagnóstico básico sai do semáforo
  });

  it("login desconhecido é 404; ONU não liberada é 409", async () => {
    const { ate } = await partner();
    await ctx.call(ate, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await ctx.call(ate, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    expect((await ctx.call(ate, "GET", `/onus/${reservation.id}`)).status).toBe(409);
  });

  it("outro parceiro recebe 404 e a Wiki nem é consultada; a Speed vê", async () => {
    const mine = await partner();
    const id = await client(mine.ate, "10001");
    const other = await partner("44444444000144", "OUT");
    const before = wiki.calls.length;
    expect((await ctx.call(other.ate, "GET", `/onus/${id}`)).status).toBe(404);
    expect(wiki.calls).toHaveLength(before);
    expect((await detail(await ctx.login("admin@speed.test"), id)).cliente.login).toBe("10001-JHV");
  });
});

describe("PPPoE sem leitura", () => {
  it("fibra boa sem leitura do PPPoE não vira 'tudo certo' (33766-JHV, 29 out 2026)", () => {
    const status = {
      login: "33766-JHV",
      fibra: { estado: "online", sinalDbm: -22, uptimeDesde: null, ultimaQuedaEm: null, atualizadoEm: new Date().toISOString() },
      autenticacao: { estado: "desconhecido", ip: null, desde: null, atualizadoEm: new Date().toISOString() },
      contrato: { estado: "ativo", desde: null, atualizadoEm: new Date().toISOString() },
      onu: { serial: "HWTCD5B0DFA3", modelo: "HG8145V5", olt: "OLT_BACKBONE_CENTRAL", vlan: null },
      bloqueio: null,
    } as never;
    const out = diagnose({ detalhe: null, status, minimoDbm: -22.9, bloqueado: false, login: "33766-JHV" });
    expect(out.map((a) => a.codigo)).toEqual(["sem_leitura"]);
    expect(out[0]).toMatchObject({ titulo: "PPPoE sem leitura", acao: "reiniciar" });
  });
});

describe("PPPoE logo depois de religar a ONU", () => {
  it("aguardando_leitura_apos_religar mostra 'Verificando conexão…', não alerta de PPPoE caído", () => {
    const status = {
      login: "33766-JHV",
      fibra: { estado: "online", sinalDbm: -22, uptimeDesde: null, ultimaQuedaEm: null, atualizadoEm: new Date().toISOString() },
      autenticacao: { estado: "desconhecido", ip: null, desde: null, atualizadoEm: null, motivo: "aguardando_leitura_apos_religar" },
      contrato: { estado: "ativo", desde: null, atualizadoEm: new Date().toISOString() },
      onu: { serial: "HWTCD5B0DFA3", modelo: "HG8145V5", olt: "OLT_BACKBONE_CENTRAL", vlan: null },
      bloqueio: null,
    } as never;
    const out = diagnose({ detalhe: null, status, minimoDbm: -22.9, bloqueado: false, login: "33766-JHV" });
    expect(out).toEqual([expect.objectContaining({ codigo: "sem_leitura", titulo: "Verificando conexão…", acao: null })]);
  });
});
