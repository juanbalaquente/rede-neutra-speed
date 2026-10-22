import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, ticketMessages, tickets } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { MockTicketService } from "../src/integrations/mock-tickets.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let wiki: MockTicketService;

beforeEach(async () => {
  wiki = new MockTicketService();
  ctx = await setup(new MockNetworkMap(), new MockActivationService(), {}, undefined, wiki);
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const NEW = { type: "cto_com_problema", description: "Caixa aberta, fibras soltas e sem etiqueta." };

async function partner(cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
  return { a, sup: await ctx.login(a.supervisor), ate: await ctx.login(a.atendente) };
}

async function reserved(cookie: string) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
  return reservation.id as string;
}

const open = async (cookie: string, body: object = NEW) => (await (await ctx.call(cookie, "POST", "/tickets", body)).json()).ticket;

describe("abrir chamado", () => {
  it("guarda no portal, entrega à Wiki e mostra prazo e histórico", async () => {
    const { ate } = await partner();
    const res = await ctx.call(ate, "POST", "/tickets", NEW);
    expect(res.status).toBe(201);
    const { ticket } = await res.json();
    expect(ticket).toMatchObject({ state: "aberto", origin: "parceiro", type: "cto_com_problema", slaHours: 48, late: false, undelivered: false });
    expect(ticket.messages.map((m: { author: string; body: string }) => `${m.author}: ${m.body}`)).toEqual(["sistema: Chamado aberto."]);
    expect(new Date(ticket.dueAt).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    // O que a Wiki recebeu: parceiro, tipo, SLA e nada além disso.
    expect(wiki.created).toHaveLength(1);
    expect(wiki.created[0]).toMatchObject({ tipo: "cto_com_problema", origem: "parceiro", parceiro: { codigo: "JHV", nome: "JHV Telecom" }, slaHoras: 48, fotos: [] });
    expect((await ctx.db.select().from(auditLog)).find((l) => l.action === "chamado.aberto")?.data).toMatchObject({ tipo: "cto_com_problema", origem: "parceiro" });
  });

  it("do cliente: herda CTO e login, e manda as fotos com link assinado", async () => {
    const { ate } = await partner();
    const rid = await reserved(ate);
    await ctx.upload(ate, rid, { kind: "medicao" });
    const photo = (await (await ctx.call(ate, "GET", `/reservations/${rid}/photos`)).json()).photos[0];
    await ctx.setCliente(ate, rid);
    const { activation } = await (await ctx.call(ate, "POST", "/activations", { reservationId: rid, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 })).json();
    for (let i = 0; i < 5; i++) await ctx.call(ate, "GET", `/activations/${activation.id}`);
    const ticket = await open(ate, { ...NEW, type: "porta_off", reservationId: rid, signalDbm: -23.4, photoIds: [photo.id] });
    expect(ticket).toMatchObject({ ctoName: "CTO-TESTE-01", login: "12345-JHV", signalDbm: -23.4 });
    expect(wiki.created[0]).toMatchObject({ ctoId: "CTO-TESTE-01", login: "12345-JHV", sinalMedidoDbm: -23.4 });
    expect(wiki.created[0]!.fotos).toHaveLength(1);
    expect(wiki.created[0]!.fotos[0]!.url).toMatch(/\/api\/photos\/shared\/.+\..+/);
    // O link vale: abre a foto sem login.
    const path = wiki.created[0]!.fotos[0]!.url.slice(wiki.created[0]!.fotos[0]!.url.indexOf("/api/"));
    expect((await ctx.app.request(path)).status).toBe(200);
  });

  it("valida: tipo automático, descrição curta, cliente e fotos de outro parceiro", async () => {
    const mine = await partner();
    const other = await partner("22222222000122", "OUT");
    const otherRid = await reserved(other.ate);
    await ctx.upload(other.ate, otherRid, { kind: "medicao" });
    const otherPhoto = (await (await ctx.call(other.ate, "GET", `/reservations/${otherRid}/photos`)).json()).photos[0];
    expect((await ctx.call(mine.ate, "POST", "/tickets", { ...NEW, type: "trava_sinal" })).status).toBe(422);
    expect((await ctx.call(mine.ate, "POST", "/tickets", { ...NEW, description: "ruim" })).status).toBe(400);
    expect((await ctx.call(mine.ate, "POST", "/tickets", { ...NEW, type: "lixo" })).status).toBe(400);
    expect((await ctx.call(mine.ate, "POST", "/tickets", { ...NEW, reservationId: otherRid })).status).toBe(404);
    expect((await ctx.call(mine.ate, "POST", "/tickets", { ...NEW, photoIds: [otherPhoto.id] })).status).toBe(404);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "POST", "/tickets", NEW)).status).toBe(403);
    expect(wiki.created).toHaveLength(0);
  });
});

describe("SLA por tipo", () => {
  it("a Speed muda o prazo sem mexer em código; vale para os chamados novos", async () => {
    const { ate, sup } = await partner();
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(sup, "PUT", "/admin/settings/sla", { type: "porta_off", hours: 12 })).status).toBe(403);
    const before = (await (await ctx.call(adm, "GET", "/admin/settings/sla")).json()).sla;
    expect(before.porta_off).toBe(24);
    expect((await ctx.call(adm, "PUT", "/admin/settings/sla", { type: "porta_off", hours: 12 })).status).toBe(200);
    expect((await ctx.call(adm, "PUT", "/admin/settings/sla", { type: "porta_off", hours: 0 })).status).toBe(400);
    expect((await ctx.call(adm, "PUT", "/admin/settings/sla", { type: "outro", hours: 12 })).status).toBe(400);
    const t = await open(ate, { ...NEW, type: "porta_off" });
    expect(t.slaHours).toBe(12);
    expect(wiki.created[0]!.slaHoras).toBe(12);
    expect((await open(ate)).slaHours).toBe(48); // os outros tipos seguem o padrão
    expect((await ctx.db.select().from(auditLog)).find((l) => l.action === "config.sla")?.data).toMatchObject({ tipo: "porta_off", before: 24, after: 12 });
  });

  it("chamado vencido e aberto aparece como atrasado", async () => {
    const { ate } = await partner();
    const t = await open(ate);
    await ctx.db.update(tickets).set({ dueAt: new Date(Date.now() - 3600_000) }).where(eq(tickets.id, t.id));
    const list = (await (await ctx.call(ate, "GET", "/tickets")).json()).tickets;
    expect(list[0]).toMatchObject({ late: true });
    const dash = await (await ctx.call(ate, "GET", "/dashboard")).json();
    expect(dash).toMatchObject({ chamadosAbertos: 1, chamadosAtrasados: 1 });
  });
});

describe("Wiki fora do ar ou desligada", () => {
  it("o chamado fica recebido e a entrega pode ser repetida sem duplicar", async () => {
    const { ate } = await partner();
    wiki.failNext = true;
    const t = await open(ate);
    expect(t).toMatchObject({ state: "recebido", undelivered: true });
    expect(wiki.created).toHaveLength(0);
    const retry = await ctx.call(ate, "POST", `/tickets/${t.id}/retry`);
    expect(retry.status).toBe(200);
    expect((await retry.json()).ticket).toMatchObject({ state: "aberto", undelivered: false });
    expect(wiki.created).toHaveLength(1);
    expect((await ctx.call(ate, "POST", `/tickets/${t.id}/retry`)).status).toBe(409);
  });

  it("sem integração o chamado fica guardado e reenviar avisa que está desligado", async () => {
    const off = await setup();
    const a = await off.createPartner("A", "33333333000133", { code: "AAA" });
    const cookie = await off.login(a.atendente);
    const created = await (await off.call(cookie, "POST", "/tickets", NEW)).json();
    expect(created.ticket).toMatchObject({ state: "recebido", undelivered: true });
    const retry = await off.call(cookie, "POST", `/tickets/${created.ticket.id}/retry`);
    expect(retry.status).toBe(503);
    expect((await (await off.call(cookie, "GET", "/tickets")).json()).tickets).toHaveLength(1);
    await off.close();
  });
});

describe("acompanhamento", () => {
  it("o estado e as mensagens da Infra entram sem duplicar, e resolvido encerra", async () => {
    const { ate } = await partner();
    const t = await open(ate);
    const first = (await (await ctx.call(ate, "GET", `/tickets/${t.id}`)).json()).ticket;
    expect(first.state).toBe("em_atendimento");
    expect(first.messages.map((m: { author: string }) => m.author)).toEqual(["sistema", "infra"]);
    const second = (await (await ctx.call(ate, "GET", `/tickets/${t.id}`)).json()).ticket;
    expect(second).toMatchObject({ state: "resolvido", late: false });
    expect(second.resolvedAt).toBeTruthy();
    expect(second.messages.map((m: { author: string }) => m.author)).toEqual(["sistema", "infra", "infra"]);
    // Encerrado: não pergunta mais à Wiki e não acumula mensagem.
    const third = (await (await ctx.call(ate, "GET", `/tickets/${t.id}`)).json()).ticket;
    expect(third.messages).toHaveLength(3);
    expect((await ctx.db.select().from(auditLog)).map((l) => l.action)).toEqual(expect.arrayContaining(["chamado.em_atendimento", "chamado.resolvido"]));
  });

  it("o parceiro responde, e a Wiki recebe; chamado encerrado não aceita mensagem", async () => {
    const { ate } = await partner();
    const t = await open(ate);
    const res = await ctx.call(ate, "POST", `/tickets/${t.id}/messages`, { text: "Mandei mais uma foto da caixa." });
    expect(res.status).toBe(200);
    expect(wiki.messages).toEqual([{ chamadoId: expect.any(String), texto: "Mandei mais uma foto da caixa." }]);
    expect((await ctx.db.select().from(ticketMessages)).map((m) => m.author)).toContain("parceiro");
    await ctx.call(ate, "GET", `/tickets/${t.id}`);
    await ctx.call(ate, "GET", `/tickets/${t.id}`); // resolvido
    expect((await ctx.call(ate, "POST", `/tickets/${t.id}/messages`, { text: "Ainda dá tempo?" })).status).toBe(409);
    expect((await ctx.call(ate, "POST", `/tickets/${t.id}/messages`, { text: "x" })).status).toBe(400);
  });

  it("isolamento: outro parceiro não vê nem responde; a Speed vê todos, só leitura", async () => {
    const mine = await partner();
    const t = await open(mine.ate);
    const other = await partner("44444444000144", "OUT");
    expect((await ctx.call(other.ate, "GET", `/tickets/${t.id}`)).status).toBe(404);
    expect((await ctx.call(other.ate, "POST", `/tickets/${t.id}/messages`, { text: "Intrometido" })).status).toBe(404);
    expect((await ctx.call(other.ate, "POST", `/tickets/${t.id}/retry`)).status).toBe(404);
    expect((await (await ctx.call(other.ate, "GET", "/tickets")).json()).tickets).toHaveLength(0);
    const adm = await ctx.login("admin@speed.test");
    const all = (await (await ctx.call(adm, "GET", "/tickets")).json()).tickets;
    expect(all).toHaveLength(1);
    expect(all[0].partnerName).toBe("JHV Telecom");
    expect((await ctx.call(adm, "GET", `/tickets/${t.id}`)).status).toBe(200);
    expect((await ctx.call(adm, "POST", `/tickets/${t.id}/messages`, { text: "Resposta da Speed" })).status).toBe(403);
    expect((await (await ctx.call(mine.ate, "GET", "/tickets")).json()).tickets[0].partnerName).toBeNull();
  });
});

describe("trava de sinal abre chamado sozinha", () => {
  async function stuckOnSignal(cookie: string) {
    const rid = await reserved(cookie);
    await ctx.setCliente(cookie, rid);
    await ctx.upload(cookie, rid, { kind: "medicao" });
    const { activation } = await (await ctx.call(cookie, "POST", "/activations", { reservationId: rid, serial: "ZTEGC0000BAD", contrato: "12345", sinalCtoDbm: -20 })).json();
    for (let i = 0; i < 4; i++) await ctx.call(cookie, "GET", `/activations/${activation.id}`);
    return activation.id as string;
  }

  it("prosseguir com justificativa cria o chamado automático, com as duas medições e a foto", async () => {
    const { ate } = await partner();
    const id = await stuckOnSignal(ate);
    const res = await ctx.call(ate, "POST", `/activations/${id}/decision`, { acao: "prosseguir", justificativa: "Conector refeito e medição repetida." });
    expect(res.status).toBe(200);
    const list = (await (await ctx.call(ate, "GET", "/tickets")).json()).tickets;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ origin: "sistema", type: "trava_sinal", state: "aberto" });
    expect(list[0].description).toContain("perda de 3 dB");
    expect(list[0].description).toContain("Conector refeito");
    expect(wiki.created[0]).toMatchObject({ tipo: "trava_sinal", origem: "sistema" });
    expect(wiki.created[0]!.fotos).toHaveLength(1);
  });

  it("cancelar a ativação não abre chamado; falha na Wiki não derruba a decisão", async () => {
    const { ate } = await partner();
    const id = await stuckOnSignal(ate);
    wiki.failNext = true;
    const res = await ctx.call(ate, "POST", `/activations/${id}/decision`, { acao: "prosseguir", justificativa: "Conector refeito e medição repetida." });
    expect(res.status).toBe(200); // a instalação segue
    const list = (await (await ctx.call(ate, "GET", "/tickets")).json()).tickets;
    expect(list[0]).toMatchObject({ state: "recebido", origin: "sistema" }); // fica guardado, reenvio possível

    const other = await partner("55555555000155", "ZZZ");
    const id2 = await stuckOnSignal(other.ate);
    await ctx.call(other.ate, "POST", `/activations/${id2}/decision`, { acao: "cancelar" });
    expect((await (await ctx.call(other.ate, "GET", "/tickets")).json()).tickets).toHaveLength(0);
  });
});
