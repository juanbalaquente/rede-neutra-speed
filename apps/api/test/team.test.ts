import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

describe("equipe gerida pelo supervisor", () => {
  it("cadastra atendente no próprio parceiro, mesmo se mandar o id de outro", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const sup = await ctx.login(a.supervisor);
    const res = await ctx.call(sup, "POST", "/users", { name: "Nova Atendente", email: "nova@a.test", password: PASSWORD, role: "atendente", partnerId: b.partner.id });
    expect(res.status).toBe(201);
    const listA = await (await ctx.call(sup, "GET", "/users")).json();
    expect(listA.users.map((u: { email: string }) => u.email)).toContain("nova@a.test");
    const listB = await (await ctx.call(await ctx.login(b.supervisor), "GET", "/users")).json();
    expect(listB.users.map((u: { email: string }) => u.email)).not.toContain("nova@a.test");
  });

  it("supervisor não desativa a si mesmo; atendente não gerencia equipe", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const sup = await ctx.login(a.supervisor);
    const me = (await (await ctx.call(sup, "GET", "/auth/me")).json()).user;
    expect((await ctx.call(sup, "POST", `/users/${me.id}/active`, { active: false })).status).toBe(422);
    const ate = await ctx.login(a.atendente);
    expect((await ctx.call(ate, "POST", "/users", { name: "X", email: "x@a.test", password: PASSWORD, role: "atendente" })).status).toBe(403);
  });

  it("desativar um atendente corta o acesso dele na próxima requisição", async () => {
    const a = await ctx.createPartner("A", "11111111000111");
    const sup = await ctx.login(a.supervisor);
    const ate = await ctx.login(a.atendente);
    const { users } = await (await ctx.call(sup, "GET", "/users")).json();
    const target = users.find((u: { role: string }) => u.role === "atendente");
    expect((await ctx.call(sup, "POST", `/users/${target.id}/active`, { active: false })).status).toBe(200);
    expect((await ctx.call(ate, "GET", "/reservations")).status).toBe(401);
  });
});
