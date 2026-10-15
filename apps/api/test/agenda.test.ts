import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap(), new MockActivationService());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const range = (from: string, to: string) => `/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
const OCT = range("2026-10-01T00:00:00-03:00", "2026-11-01T00:00:00-03:00");

async function reserved(cnpj = "11111111000111", code = "JHV", cto = "CTO-TESTE-01") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code });
  const cookie = await ctx.login(a.atendente);
  await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
  const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: cto, address: ADDRESS })).json();
  return { a, cookie, reservation };
}

describe("agenda de visitas", () => {
  it("lista só as visitas do intervalo, com os dados do card", async () => {
    const { cookie, reservation } = await reserved();
    await ctx.setCliente(cookie, reservation.id, { visitAt: "2026-10-20T10:00:00-03:00" });
    const res = await ctx.call(cookie, "GET", OCT);
    expect(res.status).toBe(200);
    const { visits } = await res.json();
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ id: reservation.id, nickname: "Casa do Zé", technician: "Carlos Técnico", planName: "600 Mega", visitStatus: "agendada", partnerName: null });
    // Fora do intervalo: nada. O limite superior é aberto.
    expect((await (await ctx.call(cookie, "GET", range("2026-10-21T00:00:00-03:00", "2026-10-22T00:00:00-03:00"))).json()).visits).toHaveLength(0);
    expect((await (await ctx.call(cookie, "GET", range("2026-10-20T00:00:00-03:00", "2026-10-20T10:00:00-03:00"))).json()).visits).toHaveLength(0);
  });

  it("valida o intervalo", async () => {
    const { cookie } = await reserved();
    expect((await ctx.call(cookie, "GET", "/agenda")).status).toBe(400);
    expect((await ctx.call(cookie, "GET", range("2026-11-01T00:00:00-03:00", "2026-10-01T00:00:00-03:00"))).status).toBe(400);
    expect((await ctx.call(cookie, "GET", range("2026-01-01T00:00:00-03:00", "2026-12-31T00:00:00-03:00"))).status).toBe(400); // passa de 62 dias
  });

  it("isolamento: cada parceiro vê só as dele; a Speed vê todas, com o parceiro", async () => {
    const mine = await reserved();
    await ctx.setCliente(mine.cookie, mine.reservation.id);
    const other = await reserved("44444444000144", "OUT", "CTO-TESTE-03");
    await ctx.setCliente(other.cookie, other.reservation.id, { technician: "Técnico do Outro" });
    const own = (await (await ctx.call(mine.cookie, "GET", OCT)).json()).visits;
    expect(own).toHaveLength(1);
    expect(own[0].technician).toBe("Carlos Técnico");
    const all = (await (await ctx.call(await ctx.login("admin@speed.test"), "GET", OCT)).json()).visits;
    expect(all).toHaveLength(2);
    expect(all.map((v: { partnerName: string }) => v.partnerName).sort()).toEqual(["JHV Telecom", "JHV Telecom"]);
  });

  it("arrastar: muda a data, vira reagendada e audita; mesma data não muda nada", async () => {
    const { cookie, reservation } = await reserved();
    await ctx.setCliente(cookie, reservation.id, { visitAt: "2026-10-20T10:00:00-03:00" });
    const url = `/reservations/${reservation.id}/visita`;
    const same = await (await ctx.call(cookie, "PATCH", url, { visitAt: "2026-10-20T10:00:00-03:00" })).json();
    expect(same.installation.visitStatus).toBe("agendada");
    const moved = await ctx.call(cookie, "PATCH", url, { visitAt: "2026-10-23T10:00:00-03:00", technician: "Outro Técnico" });
    expect(moved.status).toBe(200);
    const { installation } = await moved.json();
    expect(installation).toMatchObject({ visitStatus: "reagendada", technician: "Outro Técnico" });
    expect(new Date(installation.visitAt).toISOString()).toBe("2026-10-23T13:00:00.000Z");
    const log = (await ctx.db.select().from(auditLog)).filter((l) => l.action === "visita.reagendada");
    expect(log).toHaveLength(1);
    // O card aparece no novo dia.
    const day = range("2026-10-23T00:00:00-03:00", "2026-10-24T00:00:00-03:00");
    expect((await (await ctx.call(cookie, "GET", day)).json()).visits).toHaveLength(1);
  });

  it("não reagenda sem visita marcada, com O.S. fechada, de outro parceiro nem pela Speed", async () => {
    const mine = await reserved();
    const url = `/reservations/${mine.reservation.id}/visita`;
    const body = { visitAt: "2026-10-23T10:00:00-03:00" };
    expect((await ctx.call(mine.cookie, "PATCH", url, body)).status).toBe(409); // ainda sem dados do cliente
    await ctx.setCliente(mine.cookie, mine.reservation.id);
    const other = await ctx.createPartner("Outro", "55555555000155", { code: "OUT" });
    expect((await ctx.call(await ctx.login(other.atendente), "PATCH", url, body)).status).toBe(404);
    expect((await ctx.call(await ctx.login("admin@speed.test"), "PATCH", url, body)).status).toBe(403);
    expect((await ctx.call(mine.cookie, "PATCH", url, { visitAt: "amanhã" })).status).toBe(400);
  });
});
