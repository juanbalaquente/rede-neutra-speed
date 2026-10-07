import { describe, expect, it } from "vitest";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { setup } from "./helpers.js";

const cto = (extra: { name: string } & Record<string, unknown>) => ({ lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [1], ...extra });

describe("relatório de CTOs em conferir", () => {
  async function prepared() {
    const net = new MockNetworkMap([
      cto({ id: "ok", name: "CTO-OK" }),
      cto({ id: "div", name: "CTO-DIVERGE", mapFree: 2 }),
      cto({ id: "x", name: "=CTO-SEM-ID", unresolved: true }),
    ]);
    const ctx = await setup(net);
    const a = await ctx.createPartner("A", "11111111000111");
    const b = await ctx.createPartner("B", "22222222000122");
    const ca = await ctx.login(a.atendente);
    const cb = await ctx.login(b.atendente);
    const q = (cookie: string, address: string) => ctx.call(cookie, "POST", "/viability", { address });
    await q(ca, "Rua Um, 100, Belo Horizonte");
    await q(ca, "Rua Dois, 200, Belo Horizonte");
    await q(ca, "Rua Dois, 200, Belo Horizonte");
    await q(cb, "Rua Um, 100, Belo Horizonte");
    const admin = await ctx.login("admin@speed.test");
    return { ctx, admin, a };
  }

  it("agrega por CTO: consultas, endereços, parceiros e motivos; só 'conferir' entra", async () => {
    const { ctx, admin } = await prepared();
    try {
      const body = await (await ctx.call(admin, "GET", "/admin/cto-conferir?days=7")).json();
      const names = body.rows.map((r: { name: string }) => r.name);
      expect(names).not.toContain("CTO-OK");
      const div = body.rows.find((r: { name: string }) => r.name === "CTO-DIVERGE");
      expect(div).toMatchObject({ ctoId: "div", consultas: 4, enderecos: 2, parceiros: 2, motivos: ["vagas_acima_do_mapa"] });
      const semId = body.rows.find((r: { name: string }) => r.name === "=CTO-SEM-ID");
      expect(semId).toMatchObject({ ctoId: null, consultas: 4, motivos: ["cto_sem_id"] });
      expect(body.rows[0].consultas).toBeGreaterThanOrEqual(body.rows[1].consultas);
    } finally {
      await ctx.close();
    }
  });

  it("CSV baixa com cabeçalho e protege célula que começa com =", async () => {
    const { ctx, admin } = await prepared();
    try {
      const res = await ctx.call(admin, "GET", "/admin/cto-conferir?format=csv");
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const csv = await res.text();
      expect(csv.split("\n")[0]).toBe("id_codemaps,nome,consultas,enderecos,parceiros,ultima_consulta,motivos");
      expect(csv).toContain("'=CTO-SEM-ID");
      expect(csv).not.toMatch(/(^|,)=CTO-SEM-ID/m);
    } finally {
      await ctx.close();
    }
  });

  it("parceiro não acessa; período inválido é 400", async () => {
    const { ctx, admin, a } = await prepared();
    try {
      expect((await ctx.call(await ctx.login(a.supervisor), "GET", "/admin/cto-conferir")).status).toBe(403);
      expect((await ctx.call(admin, "GET", "/admin/cto-conferir?days=0")).status).toBe(400);
      expect((await ctx.call(admin, "GET", "/admin/cto-conferir?days=abc")).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});
