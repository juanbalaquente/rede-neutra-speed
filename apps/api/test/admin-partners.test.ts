import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, setup } from "./helpers.js";

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

describe("gestão de parceiros pelo administrador Speed", () => {
  it("a lista traz o uso atual: reservas abertas e usuários ativos", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    await ctx.createPartner("Beta", "22222222000122");
    const ca = await ctx.login(a.atendente);
    await ctx.call(ca, "POST", "/viability", { address: ADDRESS });
    expect((await ctx.call(ca, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS })).status).toBe(201);

    const { partners } = await (await ctx.call(admin, "GET", "/admin/partners")).json();
    const alfa = partners.find((p: { name: string }) => p.name === "Alfa");
    const beta = partners.find((p: { name: string }) => p.name === "Beta");
    expect(alfa).toMatchObject({ activeReservations: 1, activeUsers: 2, allowedRegions: ["ITA"] });
    expect(beta).toMatchObject({ activeReservations: 0, activeUsers: 2 });
  });

  it("cria parceiro com siglas normalizadas; CNPJ inválido ou repetido é recusado", async () => {
    const res = await ctx.call(admin, "POST", "/admin/partners", { name: "NetVale", cnpj: "33333333000133", allowedRegions: ["r1", " ita "] });
    expect(res.status).toBe(201);
    expect((await res.json()).partner.allowedRegions).toEqual(["R1", "ITA"]);
    expect((await ctx.call(admin, "POST", "/admin/partners", { name: "X", cnpj: "33.333.333/0001-33" })).status).toBe(400);
    expect((await ctx.call(admin, "POST", "/admin/partners", { name: "Outro", cnpj: "33333333000133" })).status).toBe(409);
  });

  it("parceiro novo sem siglas não vê CTO nenhuma (liberação explícita)", async () => {
    const res = await ctx.call(admin, "POST", "/admin/partners", { name: "Sem Área", cnpj: "44444444000144" });
    const { partner } = await res.json();
    expect(partner.allowedRegions).toEqual([]);
  });

  it("o administrador cadastra o primeiro supervisor do parceiro, que entra em seguida", async () => {
    const { partner } = await (await ctx.call(admin, "POST", "/admin/partners", { name: "NetVale", cnpj: "33333333000133" })).json();
    const res = await ctx.call(admin, "POST", "/users", { name: "Ana Supervisora", email: "Ana@NetVale.test", password: PASSWORD, role: "supervisor", partnerId: partner.id });
    expect(res.status).toBe(201);
    const cookie = await ctx.login("ana@netvale.test");
    const me = await (await ctx.call(cookie, "GET", "/partner")).json();
    expect(me.partner.id).toBe(partner.id);
    const list = await (await ctx.call(admin, "GET", `/users?partnerId=${partner.id}`)).json();
    expect(list.users).toHaveLength(1);
  });

  it("reativar um usuário respeita o limite de usuários do parceiro", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111", { maxUsers: 2 });
    const { users } = await (await ctx.call(admin, "GET", `/users?partnerId=${a.partner.id}`)).json();
    const target = users.find((u: { role: string }) => u.role === "atendente");
    expect((await ctx.call(admin, "POST", `/users/${target.id}/active`, { active: false })).status).toBe(200);
    // Com a vaga liberada, entra outro usuário: o parceiro volta a 2 ativos.
    expect((await ctx.call(admin, "POST", "/users", { name: "Novo", email: "novo@alfa.test", password: PASSWORD, role: "atendente", partnerId: a.partner.id })).status).toBe(201);
    const back = await ctx.call(admin, "POST", `/users/${target.id}/active`, { active: true });
    expect(back.status).toBe(409);
    expect((await back.json()).error).toBe("limite_usuarios");
  });

  it("reativar o parceiro bloqueado devolve o acesso, sem exigir motivo", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    const ca = await ctx.login(a.atendente);
    await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { status: "bloqueado", reason: "inadimplência" });
    expect((await ctx.call(ca, "GET", "/reservations")).status).toBe(403);
    expect((await ctx.call(admin, "PATCH", `/admin/partners/${a.partner.id}`, { status: "ativo" })).status).toBe(200);
    expect((await ctx.call(ca, "GET", "/reservations")).status).toBe(200);
  });

  it("supervisor de parceiro não acessa a gestão de parceiros", async () => {
    const a = await ctx.createPartner("Alfa", "11111111000111");
    const sup = await ctx.login(a.supervisor);
    expect((await ctx.call(sup, "GET", "/admin/partners")).status).toBe(403);
    expect((await ctx.call(sup, "PATCH", `/admin/partners/${a.partner.id}`, { allowedRegions: ["R1"] })).status).toBe(403);
  });
});
