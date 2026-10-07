import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, portReservations, viabilityQueries } from "../src/db/schema.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
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
async function reserve(cookie: string, ctoId: string) {
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  return ctx.call(cookie, "POST", "/reservations", { ctoId, address: ADDRESS });
}

const vagasOf = (body: { ctos: { ctoId: string; vagas: number }[] }, id: string) => body.ctos.find((c) => c.ctoId === id)!.vagas;

describe("viabilidade", () => {
  it("devolve as vagas livres por CTO e registra a consulta", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const res = await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.viable).toBe(true);
    expect(vagasOf(body, "CTO-TESTE-01")).toBe(11); // 16 saídas, 5 ocupadas
    expect(vagasOf(body, "CTO-TESTE-03")).toBe(8);
    expect(body.ctos.find((c: { ctoId: string }) => c.ctoId === "CTO-TESTE-02").blockedReason).toBe("sem_vaga_livre");
    expect(body.ctos[0]).not.toHaveProperty("freePorts");
    expect(body.plans.length).toBe(4);
    expect(await ctx.db.select().from(viabilityQueries)).toHaveLength(1);
  });

  it("registra consulta sem viabilidade (demanda reprimida)", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const body = await (await ctx.call(cookie, "POST", "/viability", { address: "sem viabilidade, rua longe, 1" })).json();
    expect(body.viable).toBe(false);
    expect(body.plans).toHaveLength(0);
    const [q] = await ctx.db.select().from(viabilityQueries);
    expect(q?.reason).toBe("nenhuma_cto_no_raio");
  });

  it("recusa Plus Code", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const res = await ctx.call(await ctx.login(a.atendente), "POST", "/viability", { address: "438Q+28W Belo Horizonte" });
    expect(res.status).toBe(422);
  });

  it("vaga reservada por outro parceiro some das vagas de todos", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const ca = await ctx.login(a.atendente);
    const cb = await ctx.login(b.atendente);
    expect((await reserve(ca, "CTO-TESTE-03")).status).toBe(201);
    const body = await (await ctx.call(cb, "POST", "/viability", { address: ADDRESS })).json();
    expect(vagasOf(body, "CTO-TESTE-03")).toBe(7);
  });
});

describe("área liberada por sigla", () => {
  it("parceiro só vê CTOs das siglas liberadas; fora disso, 'fora da área' e demanda registrada", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { allowedRegions: ["R1"] });
    const body = await (await ctx.call(await ctx.login(a.atendente), "POST", "/viability", { address: ADDRESS })).json();
    expect(body.ctos).toHaveLength(0);
    expect(body.viable).toBe(false);
    expect(body.foraDaArea).toBe(true);
    const [q] = await ctx.db.select().from(viabilityQueries);
    expect(q?.reason).toBe("fora_da_area");
    expect((q?.result as { foraDaAreaCount: number }).foraDaAreaCount).toBe(3);
  });

  it("sem siglas liberadas, nada é oferecido; o administrador vê tudo", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { allowedRegions: [] });
    expect((await (await ctx.call(await ctx.login(a.atendente), "POST", "/viability", { address: ADDRESS })).json()).ctos).toHaveLength(0);
    const admin = await (await ctx.call(await ctx.login("admin@speed.test"), "POST", "/viability", { address: ADDRESS })).json();
    expect(admin.ctos).toHaveLength(3);
  });

  it("a área vale no servidor: se a Speed tira a sigla depois da consulta, a reserva é recusada", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    await ctx.call(ca, "POST", "/viability", { address: ADDRESS });
    const admin = await ctx.login("admin@speed.test");
    expect((await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { allowedRegions: ["r1", "fat"] })).status).toBe(200);
    const res = await ctx.call(ca, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("fora_da_area");
  });

  it("o administrador define as siglas (normalizadas) e o parceiro enxerga a própria lista", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { allowedRegions: [] });
    const admin = await ctx.login("admin@speed.test");
    const res = await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { allowedRegions: ["r1", "ita", "Fat"] });
    expect((await res.json()).partner.allowedRegions).toEqual(["R1", "ITA", "FAT"]);
    expect((await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { allowedRegions: ["R 1!"] })).status).toBe(400);
    const mine = await (await ctx.call(await ctx.login(a.atendente), "GET", "/partner")).json();
    expect(mine.partner.allowedRegions).toEqual(["R1", "ITA", "FAT"]);
  });
});

describe("reserva de vaga", () => {
  it("reserva por 48h e consome uma vaga, sem número de porta", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const res = await reserve(await ctx.login(a.atendente), "CTO-TESTE-03");
    expect(res.status).toBe(201);
    const { reservation } = await res.json();
    const hours = (new Date(reservation.expiresAt).getTime() - new Date(reservation.createdAt).getTime()) / 3600_000;
    expect(hours).toBeCloseTo(48, 5);
    expect(reservation.port).toBeNull();
    expect(reservation.totalPorts).toBe(8);
  });

  it("a última vaga é de um parceiro só, mesmo em corrida", async () => {
    const net = new MockNetworkMap([{ name: "CTO-UMA", lat: -19.9191, lng: -43.9386, totalPorts: 2, occupied: [1] }]);
    const c2 = await setup(net);
    try {
      const a = await c2.createPartner("A", "11111111000111");
      const b = await c2.createPartner("B", "22222222000122");
      const ca = await c2.login(a.atendente);
      const cb = await c2.login(b.atendente);
      await c2.call(ca, "POST", "/viability", { address: ADDRESS });
      await c2.call(cb, "POST", "/viability", { address: ADDRESS });
      const go = (cookie: string) => c2.call(cookie, "POST", "/reservations", { ctoId: "CTO-UMA", address: ADDRESS });
      const results = await Promise.all([go(ca), go(cb)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect((await loser.json()).error).toBe("sem_vaga");
      expect(await c2.db.select().from(portReservations)).toHaveLength(1);
    } finally {
      await c2.close();
    }
  });

  it("CTO sem vaga livre não reserva", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const res = await reserve(await ctx.login(a.atendente), "CTO-TESTE-02");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("sem_vaga");
  });

  it("respeita o limite de reservas simultâneas", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { maxActiveReservations: 2, maxCtoOccupancyPct: 100 });
    const ca = await ctx.login(a.atendente);
    expect((await reserve(ca, "CTO-TESTE-03")).status).toBe(201);
    expect((await reserve(ca, "CTO-TESTE-03")).status).toBe(201);
    const third = await reserve(ca, "CTO-TESTE-03");
    expect(third.status).toBe(409);
    expect((await third.json()).error).toBe("limite_reservas");
  });

  it("respeita o limite de ocupação por CTO (50% de 8 vagas = 4)", async () => {
    const a = await ctx.createPartner("A", "11111111000111", { maxActiveReservations: 20 });
    const ca = await ctx.login(a.atendente);
    for (let i = 0; i < 4; i++) expect((await reserve(ca, "CTO-TESTE-03")).status).toBe(201);
    const fifth = await reserve(ca, "CTO-TESTE-03");
    expect((await fifth.json()).error).toBe("limite_ocupacao_cto");
    const body = await (await ctx.call(ca, "POST", "/viability", { address: ADDRESS })).json();
    expect(body.ctos.find((c: { ctoId: string }) => c.ctoId === "CTO-TESTE-03").blockedReason).toBe("limite_ocupacao");
  });

  it("expira em 48h e devolve a vaga ao pool", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    await reserve(ca, "CTO-TESTE-03");
    expect(await expireOverdueReservations(ctx.db, new Date(Date.now() + 49 * 3600_000))).toBe(1);
    const [r] = await ctx.db.select().from(portReservations);
    expect(r?.status).toBe("expirada");
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, "reserva.expirada"))).toHaveLength(1);
    const body = await (await ctx.call(ca, "POST", "/viability", { address: ADDRESS })).json();
    expect(vagasOf(body, "CTO-TESTE-03")).toBe(8);
  });

  it("parceiro cancela a própria reserva e a vaga volta na hora", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    const { reservation } = await (await reserve(ca, "CTO-TESTE-03")).json();
    expect((await ctx.call(ca, "POST", `/reservations/${reservation.id}/cancel`, {})).status).toBe(200);
    const body = await (await ctx.call(ca, "POST", "/viability", { address: ADDRESS })).json();
    expect(vagasOf(body, "CTO-TESTE-03")).toBe(8);
  });

  it("admin da Speed cancela qualquer reserva, com motivo obrigatório", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const ca = await ctx.login(a.atendente);
    const admin = await ctx.login("admin@speed.test");
    const { reservation } = await (await reserve(ca, "CTO-TESTE-03")).json();
    expect((await ctx.call(admin, "POST", `/reservations/${reservation.id}/cancel`, {})).status).toBe(422);
    const ok = await ctx.call(admin, "POST", `/reservations/${reservation.id}/cancel`, { reason: "vaga reservada para obra" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).reservation.cancelReason).toBe("vaga reservada para obra");
  });

  it("admin da Speed não reserva vaga", async () => {
    const admin = await ctx.login("admin@speed.test");
    expect((await reserve(admin, "CTO-TESTE-03")).status).toBe(403);
  });
});

describe("isolamento entre parceiros", () => {
  it("um parceiro não vê nem cancela reserva de outro", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const ca = await ctx.login(a.atendente);
    const cb = await ctx.login(b.supervisor);
    const { reservation } = await (await reserve(ca, "CTO-TESTE-03")).json();
    expect((await (await ctx.call(cb, "GET", "/reservations")).json()).reservations).toHaveLength(0);
    expect((await ctx.call(cb, "POST", `/reservations/${reservation.id}/cancel`, {})).status).toBe(404);
    expect((await (await ctx.call(ca, "GET", "/reservations")).json()).reservations).toHaveLength(1);
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
