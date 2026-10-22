import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, capacityRequests, portReservations } from "../src/db/schema.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const FULL = "CTO-TESTE-02";

async function ask(cookie: string, ctoId = FULL) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  return ctx.call(cookie, "POST", "/capacity-requests", { ctoId, address: ADDRESS });
}

describe("pedido de vaga em CTO cheia", () => {
  it("cria o pedido sem ocupar vaga e sem reserva", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const res = await ask(await ctx.login(a.atendente));
    expect(res.status).toBe(201);
    const { request } = await res.json();
    expect(request).toMatchObject({ ctoId: FULL, status: "pendente", blockedReason: "sem_vaga_livre" });
    expect(await ctx.db.select().from(portReservations)).toHaveLength(0);
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "pedido_vaga.criado"));
    expect(audit).toHaveLength(1);
  });

  it("CTO com vaga livre reserva direto; pedido é recusado com 409", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const res = await ask(await ctx.login(a.atendente), "CTO-TESTE-03");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("cto_com_vaga");
  });

  it("exige viabilidade recente do endereço e não aceita pedido repetido", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const semConsulta = await ctx.call(cookie, "POST", "/capacity-requests", { ctoId: FULL, address: ADDRESS });
    expect(semConsulta.status).toBe(422);
    expect((await ask(cookie)).status).toBe(201);
    const repetido = await ask(cookie);
    expect(repetido.status).toBe(409);
    expect((await repetido.json()).error).toBe("pedido_existente");
  });

  it("respeita o limite de pedidos em espera do parceiro", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { maxActiveReservations: 1 });
    const cookie = await ctx.login(a.atendente);
    expect((await ask(cookie)).status).toBe(201);
    await ctx.call(cookie, "POST", "/viability", { address: "Rua Outra, 200, Belo Horizonte" });
    const segundo = await ctx.call(cookie, "POST", "/capacity-requests", { ctoId: FULL, address: "Rua Outra, 200, Belo Horizonte" });
    expect(segundo.status).toBe(409);
    expect((await segundo.json()).error).toBe("limite_pedidos");
  });

  it("isolamento: o parceiro só vê e cancela os próprios pedidos (404 no alheio)", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const { request } = await (await ask(await ctx.login(a.atendente))).json();
    const cb = await ctx.login(b.atendente);
    expect((await (await ctx.call(cb, "GET", "/capacity-requests")).json()).requests).toHaveLength(0);
    expect((await ctx.call(cb, "POST", `/capacity-requests/${request.id}/cancel`)).status).toBe(404);
    const mine = await ctx.call(await ctx.login(a.atendente), "POST", `/capacity-requests/${request.id}/cancel`);
    expect(mine.status).toBe(200);
    expect((await mine.json()).request.status).toBe("cancelado");
  });

  it("a Speed confirma: nasce reserva de 48 h na CTO cheia, com auditoria", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const { request } = await (await ask(await ctx.login(a.atendente))).json();
    const admin = await ctx.login("admin@speed.test");
    const res = await ctx.call(admin, "POST", `/admin/capacity-requests/${request.id}/decision`, { decision: "confirmar" });
    expect(res.status).toBe(200);
    const decided = (await res.json()).request;
    expect(decided.status).toBe("confirmado");
    const [reservation] = await ctx.db.select().from(portReservations);
    expect(reservation).toMatchObject({ id: decided.reservationId, partnerId: a.partner.id, ctoId: FULL, status: "ativa" });
    const hours = (reservation!.expiresAt!.getTime() - reservation!.createdAt.getTime()) / 3600_000;
    expect(Math.round(hours)).toBe(48);
    const again = await ctx.call(admin, "POST", `/admin/capacity-requests/${request.id}/decision`, { decision: "confirmar" });
    expect(again.status).toBe(409);
    expect(await ctx.db.select().from(portReservations)).toHaveLength(1);
    const confirmed = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "pedido_vaga.confirmado"));
    expect(confirmed).toHaveLength(1);
  });

  it("recusar exige motivo; só a Speed decide", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const { request } = await (await ask(cookie)).json();
    expect((await ctx.call(cookie, "POST", `/admin/capacity-requests/${request.id}/decision`, { decision: "confirmar" })).status).toBe(403);
    const admin = await ctx.login("admin@speed.test");
    expect((await ctx.call(admin, "POST", `/admin/capacity-requests/${request.id}/decision`, { decision: "recusar" })).status).toBe(422);
    // Motivo de uma letra não ajuda o parceiro: mínimo de 10 caracteres.
    expect((await ctx.call(admin, "POST", `/admin/capacity-requests/${request.id}/decision`, { decision: "recusar", note: "x" })).status).toBe(422);
    const res = await ctx.call(admin, "POST", `/admin/capacity-requests/${request.id}/decision`, { decision: "recusar", note: "Sem projeto de extensão no bairro" });
    expect((await res.json()).request).toMatchObject({ status: "recusado", decisionNote: "Sem projeto de extensão no bairro" });
    expect(await ctx.db.select().from(portReservations)).toHaveLength(0);
    const [row] = await ctx.db.select().from(capacityRequests);
    expect(row?.status).toBe("recusado");
  });

  it("a Speed vê os pedidos de todos com o nome do parceiro; o parceiro não vê os motivos técnicos", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    await ask(cookie);
    const admin = await (await ctx.call(await ctx.login("admin@speed.test"), "GET", "/capacity-requests?status=pendente")).json();
    expect(admin.requests[0]).toMatchObject({ partnerName: "A", ctoName: FULL });
    const mine = await (await ctx.call(cookie, "GET", "/capacity-requests")).json();
    expect(mine.requests[0].motivos).toEqual([]);
  });
});
