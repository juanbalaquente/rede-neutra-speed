import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { photos, portReservations } from "../src/db/schema.js";
import { MockClientStatus } from "../src/integrations/mock-client-status.js";
import { DEMO_CTOS, demoGeocode } from "../src/integrations/mock-demo.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { clearDemoData, seedDemoData } from "../src/scripts/demo-dados.js";
import { createDemoAccounts } from "../src/scripts/demo-eustaquio.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let cookies: Record<"admin" | "supervisor" | "atendente", string>;

async function loginWith(email: string, password: string) {
  const res = await ctx.app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(DEMO_CTOS, demoGeocode), undefined, {}, undefined, undefined, new MockClientStatus());
  const accounts = await createDemoAccounts(ctx.db, { resetPasswords: false });
  const pw = (role: string) => accounts.find((a) => a.email.startsWith(`eustaquio.${role}`))!;
  cookies = {
    admin: await loginWith(pw("admin").email, pw("admin").password!),
    supervisor: await loginWith(pw("supervisor").email, pw("supervisor").password!),
    atendente: await loginWith(pw("atendente").email, pw("atendente").password!),
  };
}, 30_000);
afterEach(async () => {
  await ctx.close();
});

describe("dados de demonstração do Eustáquio", () => {
  it("preenche painel, financeiro, instalações, chamados e os painéis da Speed", async () => {
    const s = await seedDemoData(ctx.db, ctx.photoStorage);
    expect(s.instalacoes).toBe(72);

    const dash = await (await ctx.call(cookies.supervisor, "GET", "/dashboard")).json();
    expect(dash.portasAtivas).toBe(68 + 0); // 72 instaladas, 4 canceladas
    expect(dash.reservasAbertas).toBe(6);
    expect(dash.osPendentes).toBe(3);
    expect(dash.visitasAtrasadas).toBeGreaterThanOrEqual(1);
    expect(dash.chamadosAbertos).toBeGreaterThanOrEqual(4);
    expect(dash.serie).toHaveLength(6);
    expect(dash.serie[5].ativasNoFim).toBeGreaterThan(dash.serie[0].ativasNoFim);

    const month = dash.serie[5].month;
    const fin = await (await ctx.call(cookies.supervisor, "GET", `/finance?month=${month}`)).json();
    expect(fin.resumo.portasAtivas).toBeGreaterThanOrEqual(68);
    expect(fin.resumo.lucroCents).toBeGreaterThan(0);
    expect(fin.resumo.semPreco).toBe(0);
    expect(fin.resumo.pagos).toBeGreaterThan(20);

    const { installations } = await (await ctx.call(cookies.atendente, "GET", "/installations")).json();
    expect(installations.length).toBe(72 + 3 + 6);
    const closed = installations.find((i: { osClosedAt: string | null }) => i.osClosedAt);
    expect(closed.photoKinds).toHaveLength(6);
    const { photos: list } = await (await ctx.call(cookies.atendente, "GET", `/reservations/${closed.id}/photos`)).json();
    const file = await ctx.call(cookies.atendente, "GET", `/photos/${list[0].id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");

    const status = await (await ctx.call(cookies.atendente, "GET", `/installations/${closed.id}/status`)).json();
    expect(status.status?.login ?? status.login).toMatch(/-EUS$/);

    const { tickets } = await (await ctx.call(cookies.atendente, "GET", "/tickets")).json();
    expect(tickets.length).toBe(10);

    const painel = await (await ctx.call(cookies.admin, "GET", "/admin/painel")).json();
    expect(painel.totals.consultas).toBeGreaterThan(150);
    expect(painel.totals.foraDaArea).toBeGreaterThan(0);
    expect(painel.totals.ctosConferir).toBeGreaterThan(0);

    const overview = await (await ctx.call(cookies.admin, "GET", "/admin/painel/parceiros")).json();
    const eus = overview.parceiros.find((p: { code: string }) => p.code === "EUS");
    expect(eus).toMatchObject({ portasAtivas: 68, bloqueados: 2, reservasAbertas: 6 });
    expect(eus.foraDoPadrao).toBe(2);
    expect(overview.hotspots.length).toBeGreaterThanOrEqual(1);
    expect(overview.totais.contratosComProblema).toBe(0);
  }, 60_000);

  it("a nova venda ao vivo ainda acha vaga e reserva na rede de demonstração", async () => {
    await seedDemoData(ctx.db, ctx.photoStorage);
    const address = "Rua Pernambuco, 1000, Funcionários, Belo Horizonte";
    const v = await (await ctx.call(cookies.atendente, "POST", "/viability", { address })).json();
    expect(v.viable).toBe(true);
    const cto = v.ctos.find((c: { blockedReason: string | null }) => c.blockedReason === null);
    const res = await ctx.call(cookies.atendente, "POST", "/reservations", { ctoId: cto.ctoId, address });
    expect(res.status).toBe(201);

    const fora = await (await ctx.call(cookies.atendente, "POST", "/viability", { address: "Rua Ceará, 20, Barreiro, Belo Horizonte" })).json();
    expect(fora).toMatchObject({ viable: false, foraDaArea: true });
  }, 60_000);

  it("apagar remove tudo do parceiro de demonstração e deixa criar de novo", async () => {
    await seedDemoData(ctx.db, ctx.photoStorage);
    await expect(seedDemoData(ctx.db, ctx.photoStorage)).rejects.toThrow(/--refazer/);
    const removed: string[] = [];
    const { reservas } = await clearDemoData(ctx.db, { removePhotoFiles: async (pid) => void removed.push(pid) });
    expect(reservas).toBe(72 + 3 + 6 + 9);
    expect(removed).toHaveLength(1);
    const [{ n } = { n: -1 }] = await ctx.db.select({ n: count() }).from(portReservations);
    expect(Number(n)).toBe(0);
    const [{ n: f } = { n: -1 }] = await ctx.db.select({ n: count() }).from(photos);
    expect(Number(f)).toBe(0);
    const again = await seedDemoData(ctx.db, ctx.photoStorage);
    expect(again.instalacoes).toBe(72);
    const [{ n: r2 } = { n: -1 }] = await ctx.db.select({ n: count() }).from(portReservations).where(eq(portReservations.status, "convertida"));
    expect(Number(r2)).toBe(68 + 3);
  }, 90_000);
});
