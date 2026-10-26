import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, customerOperations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockCustomerActions } from "../src/integrations/mock-actions.js";
import { MockClientStatus } from "../src/integrations/mock-client-status.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { OperationRefused } from "../src/integrations/wiki-actions.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let actions: MockCustomerActions;
let status: MockClientStatus;

beforeEach(async () => {
  actions = new MockCustomerActions();
  status = new MockClientStatus();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, actions, undefined, status);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const OS = { sinalFinalDbm: -21, modeloOnu: "EG8145X6", serialOnu: "HWTC00000002" };
const SENHA = "Segredo-Wifi-9876";

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

async function installed(cookie: string, contract = "10001") {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: contract, sinalCtoDbm: -20 })).json();
  for (let i = 0; i < 5; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
  for (const kind of OS_REQUIRED_KINDS.filter((k) => k !== "medicao")) await ctx.upload(cookie, reservation.id, { kind });
  expect((await ctx.call(cookie, "POST", `/reservations/${reservation.id}/os/close`, OS)).status).toBe(200);
  return reservation.id as string;
}

const wifi = (cookie: string, id: string, body: object) => ctx.call(cookie, "POST", `/installations/${id}/wifi`, body);

/** Reserva com a ONU online, mas a O.S. ainda aberta: é quando o técnico configura o Wi-Fi na instalação. */
async function onlineBeforeOs(cookie: string) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  await ctx.setCliente(cookie, reservation.id);
  await ctx.upload(cookie, reservation.id, { kind: "medicao" });
  const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: "10009", sinalCtoDbm: -20 })).json();
  return { id: reservation.id as string, activationId: activation.id as string };
}

describe("troca do Wi-Fi do cliente", () => {
  it("o técnico configura o Wi-Fi assim que a ONU fica online, com a O.S. ainda aberta", async () => {
    const { ate } = await partner();
    const { id, activationId } = await onlineBeforeOs(ate);
    // Ainda não online: recusa e não chama a Wiki.
    expect((await wifi(ate, id, { senha: SENHA })).status).toBe(409);
    expect(actions.wifiCalls).toBe(0);
    for (let i = 0; i < 5; i++) await ctx.call(ate, "GET", `/activations/${activationId}`);
    const res = await wifi(ate, id, { ssid: "Casa do Joao", senha: SENHA });
    expect(res.status).toBe(200);
    expect(actions.lastWifi).toMatchObject({ login: "10009-JHV", senha: SENHA });
  });

  it("manda nome e senha à Wiki, responde sem a senha e audita sem a senha", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const res = await wifi(ate, id, { ssid: "Casa do Joao", senha: SENHA });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(SENHA);
    expect(JSON.parse(text)).toEqual({ ok: true, ssid: "Casa do Joao" });
    expect(actions.lastWifi).toMatchObject({ login: "10001-JHV", partnerCode: "JHV", ssid: "Casa do Joao", senha: SENHA });

    // A senha não pode estar em lugar nenhum do banco.
    const audit = await ctx.db.select().from(auditLog);
    expect(JSON.stringify(audit)).not.toContain(SENHA);
    expect(audit.find((a) => a.action === "cliente.wifi_alterado")?.data).toMatchObject({ login: "10001-JHV", ssid: "Casa do Joao", senhaTrocada: true });
    expect(JSON.stringify(await ctx.db.select().from(customerOperations))).not.toContain(SENHA);
  });

  it("sem nome, troca só a senha", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    expect((await wifi(ate, id, { senha: SENHA })).status).toBe(200);
    expect(actions.lastWifi?.ssid).toBeNull();
  });

  it("recusa senha fora do padrão WPA2 antes de chegar à Wiki, sem repetir o valor na mensagem", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    // Curta, longa, com acento e sem as quatro classes (a Wiki devolveria 422 senha_fraca).
    for (const senha of ["Ab1!", "Ab1!".repeat(16), "Senhaçom1!", "senhasemclasses1", "SENHA-SEM-MINUSCULA1", "Senha-sem-numero", "SenhaSemEspecial1"]) {
      const res = await wifi(ate, id, { senha });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(senha);
    }
    expect((await wifi(ate, id, { ssid: "n".repeat(33), senha: SENHA })).status).toBe(400);
    // O nome é só ASCII (limite de 32 bytes da Wiki): acento recusa.
    expect((await wifi(ate, id, { ssid: "Casa da Conceição", senha: SENHA })).status).toBe(400);
    expect(actions.wifiCalls).toBe(0);
  });

  it("outro parceiro recebe 404 e a Wiki não é chamada", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const other = await ctx.createPartner("Outro", "22222222000122", { code: "OUT" });
    expect((await wifi(await ctx.login(other.atendente), id, { senha: SENHA })).status).toBe(404);
    expect(actions.wifiCalls).toBe(0);
  });

  it("a Speed (admin) não troca o Wi-Fi de cliente de parceiro", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const admin = await ctx.login("admin@speed.test");
    expect((await wifi(admin, id, { senha: SENHA })).status).toBe(403);
  });

  it("cliente bloqueado: recusa antes de chamar a Wiki", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const op = await (await ctx.call(ate, "POST", `/installations/${id}/operations`, { type: "bloqueio", reason: "inadimplente" })).json();
    for (let i = 0; i < 8; i++) await ctx.call(ate, "GET", `/operations/${op.operation.id}`);
    const res = await wifi(ate, id, { senha: SENHA });
    expect(res.status).toBe(409);
    expect(actions.wifiCalls).toBe(0);
  });

  it("ONU offline: mostra o motivo em português e registra a recusa", async () => {
    const { ate } = await partner();
    const id = await installed(ate, "10002");
    // O cenário -OFF vem do fim do login; o login do mock é <contrato>-JHV, então forçamos pelo código do parceiro.
    const original = actions.setWifi.bind(actions);
    actions.setWifi = (req) => original({ ...req, login: `${req.login}-OFF` });
    const res = await wifi(ate, id, { senha: SENHA });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("offline");
    expect((await ctx.db.select().from(auditLog)).some((a) => a.action === "cliente.wifi_recusado")).toBe(true);
  });

  it("código que o portal não conhece: a mensagem mostra o código (sem a senha) para dar para diagnosticar", async () => {
    const { ate } = await partner();
    const id = await installed(ate, "10004");
    actions.setWifi = async () => {
      throw new OperationRefused("codigo_novo_da_wiki", 422);
    };
    const res = await wifi(ate, id, { senha: SENHA });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("codigo_novo_da_wiki");
    expect(text).not.toContain(SENHA);
  });

  it("Wiki sem resposta: 502 'sem confirmação' e não diz que mudou", async () => {
    const { ate } = await partner();
    const id = await installed(ate, "10003");
    const original = actions.setWifi.bind(actions);
    actions.setWifi = (req) => original({ ...req, login: `${req.login}-LENTO` });
    const res = await wifi(ate, id, { senha: SENHA });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(SENHA);
    expect((await ctx.db.select().from(auditLog)).some((a) => a.action === "cliente.wifi_sem_confirmacao")).toBe(true);
  });

  describe("resultado depois do 504 (ultima-troca da Wiki)", () => {
    const outcome = (cookie: string, id: string) => ctx.call(cookie, "GET", `/installations/${id}/wifi/ultima-troca`);
    const agora = () => new Date().toISOString();

    it("sem tentativa do portal não há resultado, mesmo que a Wiki tenha uma troca antiga", async () => {
      const { ate } = await partner();
      const id = await installed(ate);
      status.wifiLast.set("10001-JHV", { estado: "aplicado", banda: null, motivo: null, ssid: "Velha", duracaoMs: 1, atualizadoEm: agora() });
      expect(await (await outcome(ate, id)).json()).toEqual({ estado: "sem_registro" });
    });

    it("troca antiga da Wiki não vale como resultado da tentativa atual", async () => {
      const { ate } = await partner();
      const id = await installed(ate);
      status.wifiLast.set("10001-JHV", { estado: "aplicado", banda: null, motivo: null, ssid: "Velha", duracaoMs: 1, atualizadoEm: new Date(Date.now() - 3600_000).toISOString() });
      await wifi(ate, id, { senha: SENHA });
      expect(await (await outcome(ate, id)).json()).toEqual({ estado: "sem_registro" });
    });

    it("devolve em andamento, aplicada e falhou da tentativa atual, sem a senha", async () => {
      const { ate } = await partner();
      const id = await installed(ate);
      await wifi(ate, id, { ssid: "Casa", senha: SENHA });
      for (const [estado, motivo] of [["em_andamento", null], ["aplicado", null], ["falhou", "sem_convergencia"]] as const) {
        status.wifiLast.set("10001-JHV", { estado, banda: estado === "falhou" ? 5 : null, motivo, ssid: "Casa", duracaoMs: 33903, atualizadoEm: agora() });
        const res = await outcome(ate, id);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        expect(text).not.toContain(SENHA);
        expect(JSON.parse(text)).toMatchObject({ estado, motivo });
      }
    });

    it("a Wiki sem troca registrada (404) vira sem_registro", async () => {
      const { ate } = await partner();
      const id = await installed(ate);
      await wifi(ate, id, { senha: SENHA });
      expect(await (await outcome(ate, id)).json()).toEqual({ estado: "sem_registro" });
    });

    it("outro parceiro recebe 404", async () => {
      const { ate } = await partner();
      const id = await installed(ate);
      await wifi(ate, id, { senha: SENHA });
      const other = await ctx.createPartner("Outro", "44444444000144", { code: "OUT" });
      expect((await outcome(await ctx.login(other.atendente), id)).status).toBe(404);
    });
  });

  it("sem o serviço de automação, responde 503", async () => {
    const off = await setup(new MockNetworkMap(), new MockActivationService());
    const a = await off.createPartner("A", "33333333000133", { code: "AAA" });
    const res = await off.call(await off.login(a.atendente), "POST", "/installations/00000000-0000-4000-8000-000000000000/wifi", { senha: SENHA });
    expect(res.status).toBe(503);
    await off.close();
  });
});
