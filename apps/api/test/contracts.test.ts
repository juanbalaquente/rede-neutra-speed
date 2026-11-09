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
let addrSeq = 0;
const ENDERECO = { cep: "34505000", rua: "Rua dos Testes", numero: "100", complemento: "", bairro: "Centro", cidade: "Sabará", uf: "mg" };

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

async function reserved(cookie: string, withCliente = true) {
  const addr = `${ADDRESS} ${++addrSeq}`; // endereço novo a cada reserva: o mesmo endereço na mesma CTO é barrado
  await ctx.call(cookie, "POST", "/viability", { address: addr });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: addr })).json();
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
    // Contrato sem valor no Voalle: a cobrança do parceiro é por fora do ERP.
    expect(sent.plano.valorMensal).toBe(0);
    expect(JSON.stringify(sent)).not.toMatch(/Cliente|nickname/i);

    const done = await settle(ate, id);
    expect(done).toMatchObject({ state: "concluida", contract: "90001", login: "90001-JHV" });
    expect(done.steps.map((s) => s.nome)).toEqual(["contrato_criado", "conexao_ajustada", "endereco_gravado", "cliente_no_oltcloud"]);
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
    plano: { velocidadeMbps: 600, valorMensal: 0 as const },
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

  it("aceita etapa em aguardando_equipe e o resultado com oltcloudClienteId (etapa 4 da Wiki, 21 out 2026)", async () => {
    const etapas = [
      { nome: "contrato_criado", estado: "concluida" },
      { nome: "conexao_ajustada", estado: "concluida" },
      { nome: "endereco_gravado", estado: "concluida" },
      { nome: "cliente_no_oltcloud", estado: "aguardando_equipe", motivo: "mais de uma conexão" },
    ];
    const parado = await build(() => json({ operacaoId: "op1", tipo: "contrato", estado: "aguardando_equipe", etapas, resultado: null, atualizadoEm: "2026-10-21T00:20:00-03:00" })).svc.get("op1", "JHV");
    expect(parado).toMatchObject({ estado: "aguardando_equipe", etapas: [{}, {}, {}, { nome: "cliente_no_oltcloud", estado: "aguardando_equipe" }] });
    const pronto = await build(() =>
      json({ operacaoId: "op1", tipo: "contrato", estado: "concluida", etapas: etapas.map((e) => ({ ...e, estado: "concluida" })), resultado: { contrato: "33721", login: "33721-JHV", oltcloudClienteId: 39700 }, atualizadoEm: "2026-10-21T00:22:00-03:00" }),
    ).svc.get("op1", "JHV");
    expect(pronto).toMatchObject({ estado: "concluida", resultado: { contrato: "33721", login: "33721-JHV" } });
  });

  it("guarda o motivo da operação (sistema_externo_indisponivel) e aceita a resposta sem ele", async () => {
    const com = await build(() => json({ operacaoId: "op1", tipo: "contrato", estado: "recebida", etapas: [], motivo: "sistema_externo_indisponivel: dns", atualizadoEm: "2026-10-21T10:30:00-03:00" })).svc.get("op1", "JHV");
    expect(com!.motivo).toBe("sistema_externo_indisponivel: dns");
    const sem = await build(() => json({ operacaoId: "op1", tipo: "contrato", estado: "recebida", etapas: [], atualizadoEm: "2026-10-21T10:30:00-03:00" })).svc.get("op1", "JHV");
    expect(sem!.motivo).toBeNull();
  });

  it("recusa de negócio vira OperationRefused; 404 é null; resposta torta é erro", async () => {
    await expect(build(() => json({ error: "parceiro_sem_cadastro" }, 422)).svc.create(REQ)).rejects.toMatchObject({ code: "parceiro_sem_cadastro", status: 422 });
    expect(await build(() => json({ error: "x" }, 404)).svc.get("nope", "JHV")).toBeNull();
    await expect(build(() => json({ operacaoId: "op", estado: "quase" })).svc.get("op", "JHV")).rejects.toThrow(/fora do contrato v3/);
    await expect(build(() => json({ error: "boom" }, 503)).svc.create(REQ)).rejects.toMatchObject({ status: 503 });
  });

  it("lê a operação de cancelamento com outro tipo e recusa o cancelamento de operação desconhecida (26 out 2026)", async () => {
    const snap = await build(() => json({ operacaoId: "c1", tipo: "cancelamento_contrato", estado: "aguardando_equipe", etapas: [{ nome: "contrato_cancelado", estado: "aguardando_equipe" }], resultado: null, atualizadoEm: "2026-10-26T13:30:00-03:00" })).svc.get("c1", "JHV");
    expect(snap).toMatchObject({ estado: "aguardando_equipe" });
    await expect(build(() => new Response(null, { status: 404 })).svc.cancel("demo-ct-1", "EUS", { idempotencyKey: REQ.idempotencyKey, motivo: "x" })).rejects.toMatchObject({ code: "contrato_desconhecido" });
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

describe("contrato que para no meio (não pode virar segundo contrato no Voalle)", () => {
  const retry = (cookie: string, id: string) => ctx.call(cookie, "POST", `/reservations/${id}/contract/retry`);

  it("parcial: fica visível, repetir com a mesma chave continua de onde parou e conclui sem duplicar", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    wiki.partialNext = true;
    await create(ate, id);
    let c = (await read(ate, id)).contract!;
    for (let i = 0; i < 6 && c.state !== "parcial"; i++) c = (await read(ate, id)).contract!;
    expect(c.state).toBe("parcial");
    expect(c.steps.map((s) => `${s.nome}:${s.estado}`)).toEqual(["contrato_criado:concluida", "conexao_ajustada:falhou", "endereco_gravado:pendente", "cliente_no_oltcloud:pendente"]);
    expect((await retry(ate, id)).status).toBe(200);
    const done = await settle(ate, id);
    expect(done).toMatchObject({ state: "concluida", contract: "90001", login: "90001-JHV" });
    expect(wiki.created).toHaveLength(1); // a Wiki recebeu um único pedido de criação
    // Já concluído: nada mais para repetir.
    expect((await retry(ate, id)).status).toBe(409);
  });

  it("falhou depois de criar algo: não aceita novo pedido (evita o segundo contrato) e avisa que a Speed resolve", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    wiki.hardFailNext = true;
    await create(ate, id);
    const failed = await settle(ate, id);
    expect(failed.state).toBe("falhou");
    expect((await read(ate, id)).contract).toMatchObject({ needsSpeed: true });
    const again = await create(ate, id);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("contrato_parcial");
    expect(wiki.created).toHaveLength(1);
  });

  it("recusa na entrada (nada criado) continua permitindo novo pedido; etapa manual espera a equipe", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    expect((await create(ate, id, { endereco: { ...ENDERECO, cep: "00000000" } })).status).toBe(409);
    expect((await read(ate, id)).contract).toMatchObject({ state: "falhou", needsSpeed: false });
    wiki.manualNext = true;
    expect((await create(ate, id)).status).toBe(202);
    let c = (await read(ate, id)).contract!;
    for (let i = 0; i < 6 && c.state !== "aguardando_equipe"; i++) c = (await read(ate, id)).contract!;
    expect(c.state).toBe("aguardando_equipe");
  });
});

describe("contratos com problema e abandono (Speed)", () => {
  const issues = async () => (await (await ctx.call(await ctx.login("admin@speed.test"), "GET", "/admin/contracts/issues")).json()).issues as { kind: string; partnerName: string; contract: string | null; reservationId: string }[];
  const abandon = async (id: string, reason = "Cliente desistiu da instalação") => ctx.call(await ctx.login("admin@speed.test"), "POST", `/admin/contracts/${id}/abandon`, { reason });

  it("lista o que precisa de olhar: parcial, etapa manual, falhou no meio, não enviado e contrato sem instalação", async () => {
    const { ate } = await partner();
    const a = await reserved(ate);
    const b = await reserved(ate);
    const c = await reserved(ate);
    const d = await reserved(ate);
    wiki.partialNext = true;
    await create(ate, a);
    wiki.hardFailNext = true;
    await create(ate, b);
    wiki.manualNext = true;
    await create(ate, c);
    for (const id of [a, b, c]) await settle(ate, id, 6);
    await create(ate, d);
    await settle(ate, d);
    // d concluiu há mais de 7 dias e nunca virou instalação.
    const { contractRequests } = await import("../src/db/schema.js");
    await ctx.db.update(contractRequests).set({ updatedAt: new Date(Date.now() - 8 * 24 * 3600_000) }).where(eq(contractRequests.reservationId, d));
    const kinds = Object.fromEntries((await issues()).map((i) => [i.reservationId, i.kind]));
    expect(kinds).toMatchObject({ [a]: "parcial", [b]: "falhou_no_meio", [c]: "aguardando_equipe", [d]: "sem_ativacao" });
    const o = await (await ctx.call(await ctx.login("admin@speed.test"), "GET", "/admin/painel/parceiros")).json();
    expect(o.totais.contratosComProblema).toBe(4);
  });

  it("pedido aceito pela Wiki e parado em recebida vira alerta, mesmo com a tela lendo sem parar (21 out 2026)", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    wiki.stuckNext = true;
    await create(ate, id);
    const { contractRequests } = await import("../src/db/schema.js");
    await ctx.db.update(contractRequests).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(contractRequests.reservationId, id));
    // A tela consulta a cada 3 s e cada leitura regrava updated_at: o alerta conta desde o pedido.
    for (let i = 0; i < 3; i++) expect((await read(ate, id)).contract!.state).toBe("recebida");
    expect((await issues()).find((i) => i.reservationId === id)?.kind).toBe("parado");
  });

  it("sistema_externo_indisponivel da Wiki chega à tela do contrato e ao cartão, e some quando ela volta (21 out 2026)", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    wiki.outageMotivo = "sistema_externo_indisponivel: getaddrinfo EAI_AGAIN erp.speednettelecom.com.br";
    await create(ate, id);
    const lendo = (await read(ate, id)).contract!;
    expect(lendo.reason).toMatch(/^sistema_externo_indisponivel/);
    const listed = (await (await ctx.call(ate, "GET", "/reservations")).json()).reservations.find((r: { id: string }) => r.id === id);
    expect(listed.contractRequest.reason).toMatch(/^sistema_externo_indisponivel/);
    wiki.outageMotivo = null;
    const done = await settle(ate, id);
    expect(done).toMatchObject({ state: "concluida", reason: null });
  });

  it("abandonar cancela a reserva, devolve a vaga e registra o número do contrato para cancelar no Voalle", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    await settle(ate, id);
    const res = await abandon(id);
    expect(res.status).toBe(200);
    expect((await res.json()).contract.state).toBe("abandonada");
    const [r] = await ctx.db.select().from(portReservations).where(eq(portReservations.id, id));
    expect(r!.status).toBe("cancelada");
    expect(r!.cancelReason).toContain("Contrato abandonado pela Speed");
    const log = (await ctx.db.select().from(auditLog)).find((l) => l.action === "contrato.abandonado");
    expect(log?.data).toMatchObject({ contrato: "90001", login: "90001-JHV", acao: "cancelar o contrato no Voalle" });
    expect((await abandon(id)).status).toBe(409); // reserva já cancelada
  });

  it("não abandona reserva que já virou instalação; só a Speed; motivo obrigatório", async () => {
    const { ate, sup } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    await settle(ate, id);
    expect((await ctx.call(sup, "POST", `/admin/contracts/${id}/abandon`, { reason: "tentativa do parceiro" })).status).toBe(403);
    expect((await abandon(id, "x")).status).toBe(400);
    await ctx.db.update(portReservations).set({ status: "convertida" }).where(eq(portReservations.id, id));
    const res = await abandon(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("reserva_com_instalacao");
  });

  it("depois de abandonado o parceiro faz uma nova reserva e um novo contrato normalmente", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    await settle(ate, id);
    await abandon(id);
    const next = await reserved(ate);
    expect((await create(ate, next)).status).toBe(202);
    expect((await settle(ate, next)).contract).toBe("90002");
  });
});

describe("cancelamento do contrato abandonado (rota combinada com a Wiki em 18 out)", () => {
  const admin = () => ctx.login("admin@speed.test");
  const abandon = async (id: string) => ctx.call(await admin(), "POST", `/admin/contracts/${id}/abandon`, { reason: "Cliente desistiu da instalação" });
  const issueOf = async (id: string) =>
    ((await (await ctx.call(await admin(), "GET", "/admin/contracts/issues")).json()).issues as { reservationId: string; kind: string; cancelState: string | null }[]).find((i) => i.reservationId === id);

  it("abandonar um contrato criado pede o cancelamento à Wiki; fica pendente até a equipe cancelar no Voalle", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    await settle(ate, id);
    const res = await abandon(id);
    expect(res.status).toBe(200);
    expect((await res.json()).contract).toMatchObject({ state: "abandonada", cancelState: "aguardando_equipe" });
    expect(wiki.cancels).toEqual([{ operacaoId: expect.any(String), motivo: "Cliente desistiu da instalação" }]);
    expect(await issueOf(id)).toMatchObject({ kind: "cancelamento_pendente", cancelState: "aguardando_equipe" });
    // A equipe cancelou no Voalle (a conexão some junto): a leitura seguinte tira o alerta.
    const { contractRequests } = await import("../src/db/schema.js");
    const [row] = await ctx.db.select().from(contractRequests).where(eq(contractRequests.reservationId, id));
    wiki.finishCancel(row!.cancelOperationId!);
    expect(await issueOf(id)).toBeUndefined();
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("contrato.cancelamento_concluida");
  });

  it("pedido que nunca chegou à Wiki: nada a cancelar no Voalle", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    wiki.failNext = true;
    await create(ate, id); // fica "recebida", sem id da Wiki
    const res = await abandon(id);
    expect((await res.json()).contract).toMatchObject({ state: "abandonada", cancelState: null });
    expect(wiki.cancels).toHaveLength(0);
    expect(await issueOf(id)).toBeUndefined();
  });

  it("Wiki fora do ar no cancelamento: fica pendente de envio, reenviar funciona com a mesma chave; e a Speed pode confirmar à mão", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    await settle(ate, id);
    wiki.failNext = true;
    expect((await (await abandon(id)).json()).contract.cancelState).toBe("pendente_envio");
    expect(await issueOf(id)).toMatchObject({ kind: "cancelamento_pendente", cancelState: "pendente_envio" });
    const adm = await admin();
    const retry = await ctx.call(adm, "POST", `/admin/contracts/${id}/cancel/retry`);
    expect(retry.status).toBe(200);
    expect((await retry.json()).contract.cancelState).toBe("aguardando_equipe");
    expect(wiki.cancels).toHaveLength(1);
    expect((await ctx.call(adm, "POST", `/admin/contracts/${id}/cancel/retry`)).status).toBe(409); // já chegou
    const done = await ctx.call(adm, "POST", `/admin/contracts/${id}/cancel/done`);
    expect(done.status).toBe(200);
    expect((await done.json()).contract.cancelState).toBe("manual");
    expect(await issueOf(id)).toBeUndefined();
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toContain("contrato.cancelado_no_voalle");
  });
});

describe("contrato no agendamento (21 out 2026: o técnico não espera em campo)", () => {
  type Listed = { id: string; contractRequest: { state: string; contract: string | null; login: string | null; readyForOnu: boolean } | null };
  const list = async (cookie: string) => (await (await ctx.call(cookie, "GET", "/reservations")).json()) as { reservations: Listed[]; contractsEnabled: boolean };

  it("cria o contrato antes de qualquer ativação e a lista de reservas mostra o estado e o login de cada uma", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    const sem = await reserved(ate);
    let body = await list(ate);
    expect(body.contractsEnabled).toBe(true);
    expect(body.reservations.find((r) => r.id === id)!.contractRequest).toBeNull();

    expect((await create(ate, id)).status).toBe(202);
    body = await list(ate);
    expect(body.reservations.find((r) => r.id === id)!.contractRequest).toMatchObject({ state: "recebida", contract: null });

    await settle(ate, id);
    body = await list(ate);
    // Com a etapa cliente_no_oltcloud concluída o cliente já pode receber a ONU: "Pronto para instalar".
    expect(body.reservations.find((r) => r.id === id)!.contractRequest).toMatchObject({ state: "concluida", contract: "90001", login: "90001-JHV", readyForOnu: true });
    expect(body.reservations.find((r) => r.id === sem)!.contractRequest).toBeNull();
  });

  it("o resumo do contrato não vaza para outro parceiro", async () => {
    const { ate } = await partner();
    const id = await reserved(ate);
    await create(ate, id);
    const outro = await partner("22222222000122", "OUT");
    expect((await list(outro.ate)).reservations.some((r) => r.id === id)).toBe(false);
  });

  it("pronto para instalar só com a etapa cliente_no_oltcloud concluída (proposta à Wiki)", async () => {
    const { readyForOnu } = await import("../src/services/reservations.js");
    const tres = [{ nome: "contrato_criado", estado: "concluida" }, { nome: "conexao_ajustada", estado: "concluida" }, { nome: "endereco_gravado", estado: "concluida" }];
    expect(readyForOnu("concluida", tres)).toBe(false);
    expect(readyForOnu("concluida", [...tres, { nome: "cliente_no_oltcloud", estado: "concluida" }])).toBe(true);
    expect(readyForOnu("executando", [...tres, { nome: "cliente_no_oltcloud", estado: "concluida" }])).toBe(false);
    expect(readyForOnu("concluida", null)).toBe(false);
  });
});
