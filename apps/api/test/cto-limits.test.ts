import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, portReservations } from "../src/db/schema.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap());
});
afterEach(async () => {
  await ctx.close();
});

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const CTO = "CTO-TESTE-01"; // 16 vagas, 5 ocupadas no mock

async function partner(pct: number, cnpj = "11111111000111", code = "JHV") {
  const a = await ctx.createPartner("JHV Telecom", cnpj, { code, maxCtoOccupancyPct: pct, maxActiveReservations: 50 });
  return { a, id: a.partner.id as string, cookie: await ctx.login(a.atendente) };
}

const viabilityOf = async (cookie: string) => {
  const v = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
  return v.ctos.find((c: { ctoId: string }) => c.ctoId === CTO) as { vagas: number; blockedReason: string | null };
};
let addrSeq = 0;
const reserve = async (cookie: string) => {
  // Endereço novo a cada reserva: o mesmo endereço na mesma CTO é barrado como duplicidade.
  const address = `${ADDRESS} ${++addrSeq}`;
  await ctx.call(cookie, "POST", "/viability", { address });
  return ctx.call(cookie, "POST", "/reservations", { ctoId: CTO, address });
};

describe("limite de ocupação por CTO", () => {
  it("a regra da CTO vale no lugar do percentual do parceiro, na viabilidade e na reserva", async () => {
    const { id, cookie } = await partner(50); // 50% de 16 = 8 vagas
    const adm = await ctx.login("admin@speed.test");
    expect((await viabilityOf(cookie)).blockedReason).toBeNull();
    // Regra: só 1 vaga (6%) nessa CTO para esse parceiro.
    const put = await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 7, reason: "CTO reservada para venda direta" });
    expect(put.status).toBe(200);
    expect((await reserve(cookie)).status).toBe(201); // usa a única vaga
    expect((await viabilityOf(cookie)).blockedReason).toBe("limite_ocupacao");
    const second = await reserve(cookie);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("limite_ocupacao_cto");
  });

  it("liberar caso a caso: 100% para um parceiro libera, e a regra de todos vale para os demais", async () => {
    const a = await partner(6); // 6% de 16 = 0 vagas: sem viabilidade
    const b = await partner(6, "22222222000122", "OUT");
    const adm = await ctx.login("admin@speed.test");
    expect((await viabilityOf(a.cookie)).blockedReason).toBe("limite_ocupacao");
    expect((await viabilityOf(b.cookie)).blockedReason).toBe("limite_ocupacao");
    await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: a.id, ctoId: CTO, maxPct: 100, reason: "Liberada caso a caso: venda combinada" });
    expect((await viabilityOf(a.cookie)).blockedReason).toBeNull();
    expect((await viabilityOf(b.cookie)).blockedReason).toBe("limite_ocupacao"); // só o parceiro A foi liberado
    // Regra para todos os parceiros nessa CTO; a regra específica de A continua valendo para A.
    await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: null, ctoId: CTO, maxPct: 50, reason: "Limite padrão da CTO" });
    expect((await viabilityOf(b.cookie)).blockedReason).toBeNull();
    expect((await viabilityOf(a.cookie)).blockedReason).toBeNull();
  });

  it("remover a regra volta ao percentual do parceiro; lista e auditoria registram", async () => {
    const { id, cookie } = await partner(50);
    const adm = await ctx.login("admin@speed.test");
    await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 0, reason: "CTO em manutenção" });
    expect((await viabilityOf(cookie)).blockedReason).toBe("limite_ocupacao");
    const { limits } = await (await ctx.call(adm, "GET", "/admin/cto-limits")).json();
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ ctoId: CTO, maxPct: 0, partnerName: "JHV Telecom" });
    expect((await ctx.call(adm, "DELETE", `/admin/cto-limits/${limits[0].id}`)).status).toBe(200);
    expect((await viabilityOf(cookie)).blockedReason).toBeNull();
    const actions = (await ctx.db.select().from(auditLog)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["config.limite_cto", "config.limite_cto_removido"]));
    expect((await ctx.call(adm, "DELETE", `/admin/cto-limits/${limits[0].id}`)).status).toBe(404);
  });

  it("só a Speed edita; valida percentual, motivo e parceiro; atualizar a mesma CTO troca a regra", async () => {
    const { id, cookie } = await partner(50);
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(cookie, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 80, reason: "tentativa" })).status).toBe(403);
    expect((await ctx.call(cookie, "GET", "/admin/cto-limits")).status).toBe(403);
    expect((await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 101, reason: "motivo válido" })).status).toBe(400);
    expect((await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 80, reason: "x" })).status).toBe(400);
    expect((await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: crypto.randomUUID(), ctoId: CTO, maxPct: 80, reason: "motivo válido" })).status).toBe(404);
    await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 80, reason: "primeira regra" });
    await ctx.call(adm, "PUT", "/admin/cto-limits", { partnerId: id, ctoId: CTO, maxPct: 30, reason: "segunda regra" });
    const { limits } = await (await ctx.call(adm, "GET", "/admin/cto-limits")).json();
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ maxPct: 30, reason: "segunda regra" });
  });
});

describe("posição da CTO para o link de rota", () => {
  it("a reserva guarda a posição da CTO vista na viabilidade e a instalação a devolve", async () => {
    const { cookie } = await partner(100);
    expect((await reserve(cookie)).status).toBe(201);
    const [r] = await ctx.db.select().from(portReservations);
    expect(r!.ctoLat).toBeCloseTo(-19.9191, 3);
    expect(r!.ctoLng).toBeCloseTo(-43.9386, 3);
    const list = (await (await ctx.call(cookie, "GET", "/installations")).json()).installations;
    expect(list[0]).toMatchObject({ ctoLat: expect.any(Number), ctoLng: expect.any(Number) });
  });
});
