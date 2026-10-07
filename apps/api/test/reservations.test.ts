import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, portReservations, viabilityQueries } from "../src/db/schema.js";
import { expireOverdueReservations } from "../src/services/reservations.js";
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

/** Reservar exige a viabilidade do endereço antes, como no fluxo real. */
async function reserve(cookie: string, ctoId: string, port: number) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  return ctx.call(cookie, "POST", "/reservations", { ctoId, port, address: ADDRESS });
}

describe("viabilidade", () => {
  it("devolve só portas livres e registra a consulta", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const res = await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viable).toBe(true);
    const cto1 = body.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-01");
    expect(cto1.freePorts).not.toContain(1);
    expect(cto1.freePorts).toContain(4);
    const cto2 = body.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-02");
    expect(cto2.blockedReason).toBe("sem_porta_livre");
    expect(body.plans.length).toBe(4);
    const logged = await ctx.db.select().from(viabilityQueries);
    expect(logged).toHaveLength(1);
  });

  it("registra consulta sem viabilidade (demanda reprimida)", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const res = await ctx.call(cookie, "POST", "/viability", { address: "sem viabilidade, rua longe, 1" });
    const body = await res.json();
    expect(body.viable).toBe(false);
    expect(body.plans).toHaveLength(0);
    const [q] = await ctx.db.select().from(viabilityQueries);
    expect(q?.viable).toBe(false);
    expect(q?.reason).toBe("nenhuma_cto_no_raio");
  });

  it("recusa Plus Code", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const res = await ctx.call(cookie, "POST", "/viability", { address: "438Q+28W Belo Horizonte" });
    expect(res.status).toBe(422);
  });

  it("porta reservada por outro parceiro não aparece como livre", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const ca = await ctx.login(a.atendente);
    const cb = await ctx.login(b.atendente);
    expect((await reserve(ca, "CTO-TESTE-03", 1)).status).toBe(201);
    const body = await (await ctx.call(cb, "POST", "/viability", { address: ADDRESS })).json();
    const cto3 = body.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-03");
    expect(cto3.freePorts).not.toContain(1);
  });
});

describe("reserva de porta", () => {
  it("reserva por 48h e trava a porta para todos", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const ca = await ctx.login(a.atendente);
    const cb = await ctx.login(b.atendente);
    const res = await reserve(ca, "CTO-TESTE-03", 2);
    expect(res.status).toBe(201);
    const { reservation } = await res.json();
    const hours = (new Date(reservation.expiresAt).getTime() - new Date(reservation.createdAt).getTime()) / 3600_000;
    expect(hours).toBeCloseTo(48, 5);
    expect((await reserve(cb, "CTO-TESTE-03", 2)).status).toBe(409);
    expect((await reserve(ca, "CTO-TESTE-03", 2)).status).toBe(409);
  });

  it("recusa porta já ocupada na rede", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const res = await reserve(await ctx.login(a.atendente), "CTO-TESTE-01", 1);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("porta_ocupada");
  });

  it("respeita o limite de reservas simultâneas", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { maxActiveReservations: 2, maxCtoOccupancyPct: 100 });
    const ca = await ctx.login(a.atendente);
    expect((await reserve(ca, "CTO-TESTE-03", 1)).status).toBe(201);
    expect((await reserve(ca, "CTO-TESTE-03", 2)).status).toBe(201);
    const third = await reserve(ca, "CTO-TESTE-03", 3);
    expect(third.status).toBe(409);
    expect((await third.json()).error).toBe("limite_reservas");
  });

  it("respeita o limite de ocupação por CTO (50% de 8 portas = 4)", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { maxActiveReservations: 20 });
    const ca = await ctx.login(a.atendente);
    for (const port of [1, 2, 3, 4]) expect((await reserve(ca, "CTO-TESTE-03", port)).status).toBe(201);
    const fifth = await reserve(ca, "CTO-TESTE-03", 5);
    expect((await fifth.json()).error).toBe("limite_ocupacao_cto");
    const body = await (await ctx.call(ca, "POST", "/viability", { address: ADDRESS })).json();
    const cto3 = body.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-03");
    expect(cto3.blockedReason).toBe("limite_ocupacao");
  });

  it("expira em 48h e devolve a porta ao pool", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    await reserve(ca, "CTO-TESTE-03", 6);
    const later = new Date(Date.now() + 49 * 3600_000);
    expect(await expireOverdueReservations(ctx.db, later)).toBe(1);
    const [r] = await ctx.db.select().from(portReservations);
    expect(r?.status).toBe("expirada");
    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.action, "reserva.expirada"));
    expect(audit).toHaveLength(1);
    expect((await reserve(ca, "CTO-TESTE-03", 6)).status).toBe(201);
  });

  it("parceiro cancela a própria reserva e libera a porta na hora", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    const { reservation } = await (await reserve(ca, "CTO-TESTE-03", 7)).json();
    expect((await ctx.call(ca, "POST", `/reservations/${reservation.id}/cancel`, {})).status).toBe(200);
    expect((await reserve(ca, "CTO-TESTE-03", 7)).status).toBe(201);
  });

  it("admin da Speed cancela qualquer reserva, com motivo obrigatório", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    const admin = await ctx.login("admin@speed.test");
    const { reservation } = await (await reserve(ca, "CTO-TESTE-03", 8)).json();
    expect((await ctx.call(admin, "POST", `/reservations/${reservation.id}/cancel`, {})).status).toBe(422);
    const ok = await ctx.call(admin, "POST", `/reservations/${reservation.id}/cancel`, { reason: "porta reservada para obra" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).reservation.cancelReason).toBe("porta reservada para obra");
  });

  it("admin da Speed não reserva porta", async () => {
    const admin = await ctx.login("admin@speed.test");
    expect((await reserve(admin, "CTO-TESTE-03", 1)).status).toBe(403);
  });
});

describe("isolamento entre parceiros", () => {
  it("um parceiro não vê nem cancela reserva de outro", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const ca = await ctx.login(a.atendente);
    const cb = await ctx.login(b.supervisor);
    const { reservation } = await (await reserve(ca, "CTO-TESTE-03", 1)).json();

    const listB = await (await ctx.call(cb, "GET", "/reservations")).json();
    expect(listB.reservations).toHaveLength(0);
    expect((await ctx.call(cb, "POST", `/reservations/${reservation.id}/cancel`, {})).status).toBe(404);

    const listA = await (await ctx.call(ca, "GET", "/reservations")).json();
    expect(listA.reservations).toHaveLength(1);
  });

  it("supervisor só gerencia usuários do próprio parceiro", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const sa = await ctx.login(a.supervisor);
    const usersB = await (await ctx.call(await ctx.login(b.supervisor), "GET", "/users")).json();
    const targetB = usersB.users.find((u: { role: string }) => u.role === "atendente");
    expect((await ctx.call(sa, "POST", `/users/${targetB.id}/active`, { active: false })).status).toBe(404);
    const usersA = await (await ctx.call(sa, "GET", "/users")).json();
    expect(usersA.users.every((u: { partnerId: string }) => u.partnerId === a.partner.id)).toBe(true);
  });

  it("atendente não acessa usuários nem administração", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    expect((await ctx.call(ca, "GET", "/users")).status).toBe(403);
    expect((await ctx.call(ca, "GET", "/admin/partners")).status).toBe(403);
  });

  it("bloquear o parceiro corta o acesso de todos os usuários dele", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    const admin = await ctx.login("admin@speed.test");
    expect((await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { status: "bloqueado" })).status).toBe(422);
    const res = await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { status: "bloqueado", reason: "inadimplência" });
    expect(res.status).toBe(200);
    expect((await ctx.call(ca, "GET", "/reservations")).status).toBe(403);
  });

  it("sem sessão não acessa nada", async () => {
    expect((await ctx.call(null, "GET", "/reservations")).status).toBe(401);
  });
});

describe("login", () => {
  it("bloqueia após 10 senhas erradas", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const attempt = () =>
      ctx.app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: a.atendente, password: "errada" }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});
