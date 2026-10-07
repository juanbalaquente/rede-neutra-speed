import { describe, expect, it } from "vitest";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { setup } from "./helpers.js";

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

/** Duas caixas distintas com o mesmo nome (caso real: ~20 nomes repetidos no OLTCloud). */
const SAME_NAME = [
  { id: "caixa-1", name: "CTO-REPETIDA", lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [] },
  { id: "caixa-2", name: "CTO-REPETIDA", lat: -19.9192, lng: -43.9387, totalPorts: 8, occupied: [1] },
];

describe("chave da CTO é o id, não o nome", () => {
  it("duas caixas com o mesmo nome reservam a mesma porta sem se bloquear", async () => {
    const ctx = await setup(new MockNetworkMap(SAME_NAME));
    try {
      const a = await ctx.createPartner("A", "11111111000111", { maxCtoOccupancyPct: 100 });
      const cookie = await ctx.login(a.atendente);
      const body = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
      expect(body.ctos.map((c: { ctoId: string }) => c.ctoId).sort()).toEqual(["caixa-1", "caixa-2"]);

      const reserve = (ctoId: string, port: number) => ctx.call(cookie, "POST", "/reservations", { ctoId, port, address: ADDRESS });
      expect((await reserve("caixa-1", 2)).status).toBe(201);
      expect((await reserve("caixa-2", 2)).status).toBe(201);
      expect((await reserve("caixa-1", 2)).status).toBe(409);

      // A porta reservada numa caixa não some da outra.
      const again = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
      const free = (id: string) => again.ctos.find((c: { ctoId: string }) => c.ctoId === id).freePorts;
      expect(free("caixa-1")).not.toContain(2);
      expect(free("caixa-2")).not.toContain(2);
      expect(free("caixa-2")).not.toContain(1);
      expect(free("caixa-1")).toContain(1);
    } finally {
      await ctx.close();
    }
  });
});

describe("reserva exige viabilidade do endereço", () => {
  it("sem consulta prévia não reserva", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const res = await ctx.call(await ctx.login(a.atendente), "POST", "/reservations", { ctoId: "CTO-TESTE-03", port: 1, address: ADDRESS });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("viabilidade_necessaria");
    } finally {
      await ctx.close();
    }
  });

  it("consulta de outro parceiro ou de outro endereço não vale", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const b = await ctx.createPartner("B", "22222222000122");
      const ca = await ctx.login(a.atendente);
      const cb = await ctx.login(b.atendente);
      await ctx.call(ca, "POST", "/viability", { address: ADDRESS });
      const other = await ctx.call(cb, "POST", "/reservations", { ctoId: "CTO-TESTE-03", port: 1, address: ADDRESS });
      expect((await other.json()).error).toBe("viabilidade_necessaria");
      const elsewhere = await ctx.call(ca, "POST", "/reservations", { ctoId: "CTO-TESTE-03", port: 1, address: "Avenida Outra, 999, Belo Horizonte" });
      expect((await elsewhere.json()).error).toBe("viabilidade_necessaria");
    } finally {
      await ctx.close();
    }
  });

  it("CTO que a consulta não listou não é reservável", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-DE-OUTRA-CIDADE", port: 1, address: ADDRESS });
      expect((await res.json()).error).toBe("viabilidade_necessaria");
    } finally {
      await ctx.close();
    }
  });
});

describe("cruzamento das duas fontes de porta livre", () => {
  const net = (mapFree?: number) =>
    new MockNetworkMap([{ id: "caixa-9", name: "CTO-CRUZA", lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [1, 2], mapFree }]);
  const reserve = (ctx: Awaited<ReturnType<typeof setup>>, cookie: string, port: number) =>
    ctx.call(cookie, "POST", "/reservations", { ctoId: "caixa-9", port, address: ADDRESS });

  it("fontes concordando oferecem as portas livres", async () => {
    const ctx = await setup(net());
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      const body = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
      expect(body.ctos[0].blockedReason).toBeNull();
      expect(body.ctos[0].freePorts).toEqual([3, 4, 5, 6, 7, 8]);
    } finally {
      await ctx.close();
    }
  });

  it("mapa e ocupação divergindo: CTO em 'conferir', sem porta e sem reserva", async () => {
    const ctx = await setup(net(3)); // o mapa diz 3 livres; a ocupação mostra 6 livres
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      const body = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
      expect(body.ctos[0].blockedReason).toBe("conferir");
      expect(body.ctos[0].freePorts).toEqual([]);
      expect(body.viable).toBe(false);
      const res = await reserve(ctx, cookie, 3);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("porta_nao_confirmada");
    } finally {
      await ctx.close();
    }
  });
});
