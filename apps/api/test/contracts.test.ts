import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { auditLog, portReservations } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockContractService } from "../src/integrations/mock-contracts.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { WikiContractService } from "../src/integrations/wiki-contracts.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let wiki: MockContractService;

beforeEach(async () => {
  wiki = new MockContractService();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, undefined, undefined, undefined, wiki);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const ENDERECO = { cep: "34505000", rua: "Rua dos Testes", numero: "100", complemento: "", bairro: "Centro", cidade: "Sabará", uf: "mg" };

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

async function reserved(cookie: string, withCliente = true) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  if (withCliente) await ctx.setCliente(cookie, reservation.id);
  return reservation.id as string;
}

const create = (cookie: string, id: string, body: object = { endereco: ENDERECO }) => ctx.call(cookie, "POST", `/reservations/${id}/contract`, body);
const read = async (cookie: string, id: string) => (await (await ctx.call(cookie, "GET", `/reservations/${id}/contract`)).json()) as { enabled: boolean; contract: { state: string; contract: string | null; login: string | null; steps: { nome: string; estado: string }[]; reason: string | null } | null };

async function settle(cookie: string, id: string, max = 8) {
  let c = (await read(cookie, id)).contract!;
  for (let i = 0; i < max && !["concluida", "falhou"].includes(c.state); i++) c = (await read(cookie, id)).contract!;
  return c;
}

describe("criação do contrato", () => {
  it("manda à Wiki o CNPJ, o plano, o endereço e a posição, sem nome de assinante, e conclui com contrato e login", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    const res = await create(ate, id);
    expect(res.status).toBe(202);
    expect((await res.json()).contract.state).toBe("recebida");
    expect(wiki.created).toHaveLength(1);
    const sent = wiki.created[0]!;
    expect(sent).toMatchObject({ reservaId: id, parceiroCnpj: "11111111000111", partnerCode: "JHV", ctoId: "CTO-TESTE-01", endereco: { cep: "34505000", uf: "MG" } });
    expect(sent.plano.velocidadeMbps).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toMatch(/Cliente|nickname/i);

    const done = await settle(ate, id);
    expect(done).toMatchObject({ state: "concluida", contract: "90001", login: "90001-JHV" });
    expect(done.steps.map((s) => s.nome)).toEqual(["contrato_criado", "conexao_ajustada", "endereco_gravado"]);
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, id));
    expect(r!.contractNumber).toBe("90001");
    expect(r!.installAddress).toMatchObject({ cidade: "Sabará" });
    const audit = (await ctx.db.select().from(auditLog)).map((l) => l.action);
    expect(audit).toEqual(expect.arrayContaining(["contrato.pedido", "contrato.concluida"]));
  });

  it("valida o endereço, os dados do cliente e a reserva", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    expect((await create(ate, id, { endereco: { ...ENDERECO, cep: "123" } })).status).toBe(400);
    expect((await create(ate, id, { endereco: { ...ENDERECO, uf: "MGX" } })).status).toBe(400);
    expect((await create(ate, id, { endereco: { ...ENDERECO, rua: "" } })).status).toBe(400);
    const bare = await reserved(ate, false);
    const res = await create(ate, bare);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("dados_cliente_obrigatorios");
    expect(wiki.created).toHaveLength(0);
  });

  it("dois cliques não viram dois contratos", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    expect((await create(ate, id)).status).toBe(202);
    const again = await create(ate, id);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("contrato_ja_pedido");
    expect(wiki.created).toHaveLength(1);
  });

  it("recusa da Wiki (parceiro sem cadastro, plano sem serviço) falha com texto claro e permite tentar de novo", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    const refused = await create(ate, id, { endereco: { ...ENDERECO, cep: "00000000" } });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.error).toBe("parceiro_sem_cadastro");
    expect(body.message).toMatch(/cadastrado/);
    expect((await read(ate, id)).contract).toMatchObject({ state: "falhou", reason: "parceiro_sem_cadastro" });
    // O pedido que falhou não trava: um novo é aceito.
    expect((await create(ate, id)).status).toBe(202);
    expect((await settle(ate, id)).state).toBe("concluida");
  });

  it("Wiki fora do ar deixa o pedido guardado; repetir envia com a mesma chave, sem duplicar", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    wiki.failNext = true;
    const res = await create(ate, id);
    expect(res.status).toBe(202);
    expect((await res.json()).contract.state).toBe("recebida");
    expect(wiki.created).toHaveLength(0);
    expect((await ctx.call(ate, "POST", `/reservations/${id}/contract/retry`)).status).toBe(200);
    expect(wiki.created).toHaveLength(1);
    expect((await ctx.call(ate, "POST", `/reservations/${id}/contract/retry`)).status).toBe(409);
    expect((await settle(ate, id)).login).toBe("90001-JHV");
  });
});

describe("ativação usa o contrato criado", () => {
  async function readyToActivate(cookie: string) {
    const id = await reserved(cookie);
    await ctx.upload(cookie, id, { kind: "medicao" });
    return id;
  }
  const activate = (cookie: string, id: string, extra: object = {}) =>
    ctx.call(cookie, "POST", "/activations", { reservationId: id, serial: "ZTEGC0000001", sinalCtoDbm: -20, ...extra });

  it("sem contrato criado a ONU não é liberada, e o número digitado é ignorado", async () => {
    const { ate } = await partner();
    const id = await readyToActivate(ate);
    const blocked = await activate(ate, id, { contrato: "55555" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("contrato_nao_criado");
    await create(ate, id);
    expect((await activate(ate, id, { contrato: "55555" })).status).toBe(409); // ainda não concluiu
    await settle(ate, id);
    const ok = await activate(ate, id, { contrato: "55555" });
    expect(ok.status).toBe(202);
    const { activation } = await ok.json();
    expect(activation.pppLogin ?? activation.login).toBe("90001-JHV");
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, id));
    expect(r!.contractNumber).toBe("90001");
  });

  it("com o modo desligado, o contrato segue digitado e a rota de criação avisa", async () => {
    const off = await setup(new MockNetworkMap(), new MockActivationService());
    const a = await off.createPartner("A", "33333333000133", { code: "AAA", maxCtoOccupancyPct: 100 });
    const cookie = await off.login(a.atendente);
    await off.call(cookie, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await off.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    expect(await (await off.call(cookie, "GET", `/reservations/${reservation.id}/contract`)).json()).toEqual({ enabled: false, contract: null });
    const res = await off.call(cookie, "POST", `/reservations/${reservation.id}/contract`, { endereco: ENDERECO });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("contrato_desligado");
    await off.setCliente(cookie, reservation.id);
    await off.upload(cookie, reservation.id, { kind: "medicao" });
    const bad = await off.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", sinalCtoDbm: -20 });
    expect(bad.status).toBe(400); // sem contrato digitado
    expect((await off.call(cookie, "POST", "/activations", { reservationId: reservation.id, serial: "ZTEGC0000001", contrato: "77777", sinalCtoDbm: -20 })).status).toBe(202);
    await off.close();
  });
});

describe("isolamento", () => {
  it("outro parceiro recebe 404 ao ler ou pedir o contrato de uma reserva alheia", async () => {
    const mine = await partner();
    const id = await reserved(mine.ate);
    const other = await partner("44444444000144", "OUT");
    expect((await ctx.call(other.ate, "GET", `/reservations/${id}/contract`)).status).toBe(404);
    expect((await create(other.ate, id)).status).toBe(404);
    expect((await ctx.call(other.ate, "POST", `/reservations/${id}/contract/retry`)).status).toBe(404);
    expect(wiki.created).toHaveLength(0);
  });
});

describe("WikiContractService (contrato v3, seção H)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const build = (respond: (url: string, init?: RequestInit) => Response) => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
      return respond(url, init);
    };
    return { svc: new WikiContractService(http, "https://wiki.exemplo/", "chave-escrita"), calls };
  };
  const REQ = {
    idempotencyKey: "3f5f7c9e-8a4c-4c52-9a1a-111111111111",
    reservaId: "r1",
    parceiroCnpj: "11111111000111",
    partnerCode: "JHV",
    plano: { velocidadeMbps: 600, valorMensal: 40 },
    ctoId: "24109",
    endereco: { cep: "34505000", rua: "Rua A", numero: "10", complemento: "", bairro: "B", cidade: "Sabará", uf: "MG" },
    location: { lat: -19.89, lng: -43.86 },
  };

  it("escreve com a chave de escrita e o código do parceiro só no header", async () => {
    const { svc, calls } = build(() => json({ operacaoId: "op1", estado: "recebida" }, 202));
    expect(await svc.create(REQ)).toEqual({ operacaoId: "op1", estado: "recebida" });
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v3/contratos");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["X-RedeNeutra-Write-Key"]).toBe("chave-escrita");
    expect(calls[0]!.headers["X-RedeNeutra-Partner"]).toBe("JHV");
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({ idempotencyKey: REQ.idempotencyKey, parceiroCnpj: "11111111000111", plano: { velocidadeMbps: 600 } });
    expect(body.partnerCode).toBeUndefined();
  });

  it("lê a operação de contrato com o resultado", async () => {
    const { svc } = build(() => json({ operacaoId: "op1", tipo: "contrato", estado: "concluida", etapas: [{ nome: "contrato_criado", estado: "concluida" }], resultado: { contrato: "33431", login: "33431-JHV" }, atualizadoEm: "2026-10-16T10:07:00-03:00" }));
    const snap = await svc.get("op1", "JHV");
    expect(snap).toMatchObject({ estado: "concluida", resultado: { contrato: "33431", login: "33431-JHV" } });
  });

  it("recusa de negócio vira OperationRefused; 404 é null; resposta torta é erro", async () => {
    await expect(build(() => json({ error: "parceiro_sem_cadastro" }, 422)).svc.create(REQ)).rejects.toMatchObject({ code: "parceiro_sem_cadastro", status: 422 });
    expect(await build(() => json({ error: "x" }, 404)).svc.get("nope", "JHV")).toBeNull();
    await expect(build(() => json({ operacaoId: "op", estado: "quase" })).svc.get("op", "JHV")).rejects.toThrow(/fora do contrato v3/);
    await expect(build(() => json({ error: "boom" }, 503)).svc.create(REQ)).rejects.toMatchObject({ status: 503 });
  });
});

describe("contrato criado trava expiração e cancelamento da reserva", () => {
  it("reserva com contrato não expira; sem contrato (ou com pedido que falhou), expira", async () => {
    const { expireOverdueReservations } = await import("../src/services/reservations.js");
    const { ate } = await partner();
    const withContract = await reserved(ate);
    await create(ate, withContract);
    const without = await reserved(ate);
    await ctx.db.update(portReservations).set({ expiresAt: new Date(Date.now() - 3600_000) });
    await expireOverdueReservations(ctx.db);
    const status = async (id: string) => (await ctx.db.select().from(portReservations).where(eq(portReservations.id, id)))[0]!.status;
    expect(await status(withContract)).toBe("ativa");
    expect(await status(without)).toBe("expirada");

    // Pedido recusado não segura a vaga: depois de falhar, a reserva volta a expirar.
    const refused = await reserved(ate);
    await create(ate, refused, { endereco: { ...ENDERECO, cep: "00000000" } });
    await ctx.db.update(portReservations).set({ expiresAt: new Date(Date.now() - 3600_000) });
    await expireOverdueReservations(ctx.db);
    expect(await status(refused)).toBe("expirada");
  });

  it("não deixa cancelar a reserva (nem a Speed) depois que o contrato foi pedido; sem contrato cancela normal", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    const blocked = await ctx.call(ate, "POST", `/reservations/${id}/cancel`, { reason: "desistiu" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("contrato_criado");
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(adm, "POST", `/reservations/${id}/cancel`, { reason: "teste" })).status).toBe(409);
    const plain = await reserved(ate);
    expect((await ctx.call(ate, "POST", `/reservations/${plain}/cancel`, { reason: "desistiu" })).status).toBe(200);
  });
});
