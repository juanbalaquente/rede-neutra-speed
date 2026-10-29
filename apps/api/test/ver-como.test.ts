import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../src/db/schema.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let admin: string;

beforeEach(async () => {
  ctx = await setup();
  admin = await ctx.login("admin@speed.test");
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

/** Entra no modo e devolve o cookie novo, que a resposta troca. */
async function verComo(partnerId: string) {
  const res = await ctx.call(admin, "POST", `/admin/partners/${partnerId}/ver-como`);
  expect(res.status).toBe(200);
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, body: await res.json() };
}

describe("administrador Speed vendo o painel do parceiro", () => {
  it("vê só os dados do parceiro escolhido, como o supervisor dele", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    const b = await ctx.createPartner("Beta", "22222222000122");
    for (const email of [a.atendente, b.atendente]) {
      const c = await ctx.login(email);
      await ctx.call(c, "POST", "/viability", { address: ADDRESS });
      expect((await ctx.call(c, "POST", "/reservations", { ctoId: email === a.atendente ? "CTO-TESTE-03" : "CTO-TESTE-01", address: ADDRESS })).status).toBe(201);
    }

    const { cookie, body } = await verComo(a.partner.id);
    expect(body.user).toMatchObject({ role: "supervisor", partnerId: a.partner.id, verComo: { partnerName: "Alfa" } });

    const session = await (await ctx.call(cookie, "GET", "/auth/session")).json();
    expect(session.user).toMatchObject({ role: "supervisor", partnerId: a.partner.id, name: "Administrador Speed" });
    expect((await (await ctx.call(cookie, "GET", "/partner")).json()).partner.name).toBe("Alfa");
    const { reservations } = await (await ctx.call(cookie, "GET", "/reservations")).json();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].ctoName).toBeDefined();
    expect((await ctx.call(cookie, "GET", "/finance")).status).toBe(200);
    // Fora do modo, a administração continua com a visão da Speed (as duas reservas).
    expect((await (await ctx.call(admin, "GET", "/reservations")).json()).reservations).toHaveLength(2);
  });

  it("é só leitura: não reserva, não mexe em preço e não alcança a administração", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    const { cookie } = await verComo(a.partner.id);
    const res = await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("somente_leitura");
    expect((await ctx.call(cookie, "PUT", "/prices", { planId: "x", priceCents: 1000 })).status).toBe(403);
    expect((await ctx.call(cookie, "GET", "/admin/partners")).status).toBe(403);
  });

  it("abre também parceiro bloqueado, para a Speed ver o que ele via", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { status: "bloqueado", reason: "inadimplência" });
    const { cookie } = await verComo(a.partner.id);
    expect((await ctx.call(cookie, "GET", "/reservations")).status).toBe(200);
  });

  it("sair volta para a administração Speed, e entrar e sair ficam na auditoria", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    const { cookie } = await verComo(a.partner.id);
    const res = await ctx.call(cookie, "POST", "/auth/ver-como/sair");
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ role: "admin_speed", partnerId: null });
    const back = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await ctx.call(back, "GET", "/admin/partners")).status).toBe(200);
    expect((await ctx.call(back, "POST", "/auth/ver-como/sair")).status).toBe(409);

    const rows = await ctx.db.select().from(auditLog).where(and(eq(auditLog.partnerId, a.partner.id), eq(auditLog.entity, "partner")));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["parceiro.ver_como", "parceiro.ver_como_fim"]));
  });

  it("parceiro inexistente responde 404, e só o administrador entra no modo", async () => {
    expect((await ctx.call(admin, "POST", "/admin/partners/00000000-0000-4000-8000-000000000000/ver-como")).status).toBe(404);
    const a = await ctx.createPartner("Alfa", "11111111000111");
    const b = await ctx.createPartner("Beta", "22222222000122");
    const sup = await ctx.login(a.supervisor);
    expect((await ctx.call(sup, "POST", `/admin/partners/${b.partner.id}/ver-como`)).status).toBe(403);
  });
});
