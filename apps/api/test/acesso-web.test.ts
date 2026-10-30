import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, customerOperations, users } from "../src/db/schema.js";
import type { Http } from "../src/integrations/http.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockCustomerActions } from "../src/integrations/mock-actions.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { IntegrationError } from "../src/integrations/types.js";
import { OperationRefused, WikiCustomerActions } from "../src/integrations/wiki-actions.js";
import { OS_REQUIRED_KINDS } from "../src/services/installations.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let actions: MockCustomerActions;

beforeEach(async () => {
  actions = new MockCustomerActions();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, actions);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const OS = { sinalFinalDbm: -21, modeloOnu: "EG8145X6", serialOnu: "HWTC00000002" };

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

const open = (cookie: string, id: string) => ctx.call(cookie, "POST", `/installations/${id}/acesso-web`);
const close = (cookie: string, id: string) => ctx.call(cookie, "DELETE", `/installations/${id}/acesso-web`);

describe("abrir a página do roteador", () => {
  it("devolve o link sem cache, manda o nome de quem abriu e audita sem o link", async () => {
    const { a, ate } = await partner();
    const id = await installed(ate);
    const res = await open(ate, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/roteador\.invalid\/abrir\//);
    expect(body.expiraEm).toBeTruthy();
    expect(actions.lastWebAccess).toMatchObject({ login: "10001-JHV", partnerCode: "JHV" });
    expect(actions.lastWebAccess!.solicitante).toBeTruthy();

    const audit = await ctx.db.select().from(auditLog);
    const row = audit.find((x) => x.action === "cliente.acesso_web_aberto");
    expect(row?.data).toMatchObject({ login: "10001-JHV", solicitante: actions.lastWebAccess!.solicitante, expiraEm: body.expiraEm });
    expect(row?.partnerId).toBe(a.partner.id);
    // Link de uso único: não fica em lugar nenhum do portal.
    const token = body.url.split("/").pop();
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(await ctx.db.select().from(customerOperations))).not.toContain(token);
  });

  it("nome longo é cortado em 120 caracteres", async () => {
    const { a, ate } = await partner();
    const id = await installed(ate);
    await ctx.db.update(users).set({ name: "n".repeat(150) }).where(eq(users.email, a.atendente));
    await open(await ctx.login(a.atendente), id);
    expect(actions.lastWebAccess!.solicitante).toBe("n".repeat(120));
  });

  it("recurso de outro parceiro responde 404 e nem chega à Wiki", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const other = await ctx.createPartner("Outro", "22222222000122", { code: "OUT" });
    const cookie = await ctx.login(other.atendente);
    expect((await open(cookie, id)).status).toBe(404);
    expect((await close(cookie, id)).status).toBe(404);
    expect(actions.lastWebAccess).toBeNull();
  });

  it("o administrador da Speed não abre", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    const admin = await ctx.login("admin@speed.test");
    expect((await open(admin, id)).status).toBe(403);
    expect(actions.lastWebAccess).toBeNull();
  });

  it("cliente bloqueado é recusado sem chegar à Wiki", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    await ctx.call(ate, "POST", `/installations/${id}/operations`, { type: "bloqueio", reason: "inadimplente" });
    const [op] = await ctx.db.select().from(customerOperations);
    for (let i = 0; i < 3; i++) await ctx.call(ate, "GET", `/operations/${op!.id}`);
    const res = await open(ate, id);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/Desbloqueie/);
    expect(actions.lastWebAccess).toBeNull();
  });

  it.each([
    ["onu_offline", 409, 409, /fora do ar/],
    ["onu_sem_acs", 409, 409, /não suporta/],
    ["onu_sem_conta_comum", 409, 409, /não suporta/],
    ["onu_sem_resposta", 409, 409, /cerca de 15 minutos/],
    ["login_recusado_pela_onu", 409, 409, /1 ou 2 minutos/],
    ["limite_de_aberturas", 429, 429, /10 vezes/],
    ["muitas_sessoes_abertas", 429, 429, /alguns minutos/],
    ["Too many requests", 429, 429, /1 minuto/],
    ["fonte_indisponivel", 502, 502, /Tente de novo/],
    ["acesso_web_desligado", 503, 503, /desligada/],
    ["login_invalido", 400, 409, /Fale com a Speed/],
  ])("recusa %s (%i) vira %i com texto em português e auditoria", async (code, status, portalStatus, text) => {
    const { ate } = await partner();
    const id = await installed(ate);
    actions.openWebAccess = async () => {
      throw new OperationRefused(code, status);
    };
    const res = await open(ate, id);
    expect(res.status).toBe(portalStatus);
    expect((await res.json()).message).toMatch(text);
    const row = (await ctx.db.select().from(auditLog)).find((a) => a.action === "cliente.acesso_web_recusado");
    expect(row?.data).toMatchObject({ login: "10001-JHV", motivo: code });
  });

  it("Wiki sem resposta vira 502 e fica na auditoria", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    actions.openWebAccess = async () => {
      throw new IntegrationError("wiki", "falha de rede", 504);
    };
    const res = await open(ate, id);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("acesso_web_falhou");
    expect((await ctx.db.select().from(auditLog)).some((a) => a.action === "cliente.acesso_web_falhou")).toBe(true);
  });

  it("encerra antes do prazo e audita; sem sessão aberta responde encerrado:false", async () => {
    const { ate } = await partner();
    const id = await installed(ate);
    await open(ate, id);
    expect(await (await close(ate, id)).json()).toEqual({ encerrado: true });
    expect(await (await close(ate, id)).json()).toEqual({ encerrado: false });
    const rows = (await ctx.db.select().from(auditLog)).filter((a) => a.action === "cliente.acesso_web_encerrado");
    expect(rows).toHaveLength(2);
  });
});

describe("WikiCustomerActions: acesso-web", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const REQ = { login: "10001-JHV", partnerCode: "JHV", solicitante: "Maria Técnica" };
  const LINK = { url: "https://roteador.spdlink.com.br/abrir/abc", expiraEm: "2026-10-30T15:00:00.000Z" };

  /** O cliente comum (15 s) nunca pode ser usado aqui: a Wiki pode levar cerca de 1 min. */
  function build(respond: () => Response) {
    const calls: { url: string; method?: string; headers: Record<string, string>; body?: string }[] = [];
    const longHttp: Http = async (url, init) => {
      calls.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string });
      return respond();
    };
    const common: Http = async () => {
      throw new Error("acesso-web não pode usar o cliente de 15 s");
    };
    return { svc: new WikiCustomerActions(common, "https://wiki.exemplo/", "chave-escrita", common, longHttp), calls };
  }

  it("POST com chave de escrita, parceiro e solicitante", async () => {
    const { svc, calls } = build(() => json(LINK));
    expect(await svc.openWebAccess(REQ)).toEqual(LINK);
    expect(calls[0]).toMatchObject({ url: "https://wiki.exemplo/proxy/redeneutra/v3/clientes/10001-JHV/acesso-web", method: "POST" });
    expect(calls[0]!.headers["X-RedeNeutra-Write-Key"]).toBe("chave-escrita");
    expect(calls[0]!.headers["X-RedeNeutra-Partner"]).toBe("JHV");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ solicitante: "Maria Técnica" });
  });

  it("DELETE devolve se encerrou", async () => {
    const { svc, calls } = build(() => json({ encerrado: true }));
    expect(await svc.closeWebAccess("10001-JHV", "JHV")).toEqual({ encerrado: true });
    expect(calls[0]).toMatchObject({ url: "https://wiki.exemplo/proxy/redeneutra/v3/clientes/10001-JHV/acesso-web", method: "DELETE" });
  });

  it.each([
    [400, "login_invalido"],
    [403, "login_de_outro_parceiro"],
    [404, "login_desconhecido"],
    [409, "onu_offline"],
    [429, "limite_de_aberturas"],
    [502, "fonte_indisponivel"],
    [503, "acesso_web_desligado"],
  ])("%i %s vira recusa de negócio com o código", async (status, error) => {
    const { svc } = build(() => json({ error }, status));
    await expect(svc.openWebAccess(REQ)).rejects.toMatchObject({ code: error, status });
  });

  it("429 sem JSON é recusa, não falha de integração", async () => {
    const { svc } = build(() => new Response("Too many requests", { status: 429 }));
    await expect(svc.openWebAccess(REQ)).rejects.toBeInstanceOf(OperationRefused);
  });

  it("401, 504 e 502 sem código são falha de integração", async () => {
    for (const status of [401, 504, 502]) {
      const { svc } = build(() => new Response("x", { status }));
      await expect(svc.openWebAccess(REQ)).rejects.toBeInstanceOf(IntegrationError);
    }
  });

  it("url fora de https é fora do contrato, e a mensagem não repete o link", async () => {
    const { svc } = build(() => json({ ...LINK, url: "http://roteador.spdlink.com.br/abrir/segredo" }));
    const e = await svc.openWebAccess(REQ).catch((x: Error) => x);
    expect(e).toBeInstanceOf(IntegrationError);
    expect(String((e as Error).message)).not.toContain("segredo");
  });
});
