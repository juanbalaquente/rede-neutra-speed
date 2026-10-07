import { describe, expect, it } from "vitest";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { setup } from "./helpers.js";

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";

/** Duas caixas distintas com o mesmo nome (caso real: ~20 nomes repetidos). */
const SAME_NAME = [
  { id: "caixa-1", name: "CTO-REPETIDA", lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [] },
  { id: "caixa-2", name: "CTO-REPETIDA", lat: -19.9192, lng: -43.9387, totalPorts: 8, occupied: [1] },
];

describe("chave da CTO é o id, não o nome", () => {
  it("duas caixas com o mesmo nome contam as vagas separadas", async () => {
    const ctx = await setup(new MockNetworkMap(SAME_NAME));
    try {
      const a = await ctx.createPartner("A", "11111111000111", { maxCtoOccupancyPct: 100 });
      const cookie = await ctx.login(a.atendente);
      const viab = async () => (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
      const vagas = (body: { ctos: { ctoId: string; vagas: number }[] }, id: string) => body.ctos.find((c) => c.ctoId === id)!.vagas;
      const first = await viab();
      expect(first.ctos.map((c: { ctoId: string }) => c.ctoId).sort()).toEqual(["caixa-1", "caixa-2"]);
      expect([vagas(first, "caixa-1"), vagas(first, "caixa-2")]).toEqual([8, 7]);

      const reserve = (ctoId: string) => ctx.call(cookie, "POST", "/reservations", { ctoId, address: ADDRESS });
      expect((await reserve("caixa-1")).status).toBe(201);
      expect((await reserve("caixa-2")).status).toBe(201);

      // A reserva de uma caixa não consome vaga da outra.
      const again = await viab();
      expect([vagas(again, "caixa-1"), vagas(again, "caixa-2")]).toEqual([7, 6]);
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
      const res = await ctx.call(await ctx.login(a.atendente), "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS });
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
      const other = await ctx.call(cb, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: ADDRESS });
      expect((await other.json()).error).toBe("viabilidade_necessaria");
      const elsewhere = await ctx.call(ca, "POST", "/reservations", { ctoId: "CTO-TESTE-03", address: "Avenida Outra, 999, Belo Horizonte" });
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
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-DE-OUTRA-CIDADE", address: ADDRESS });
      expect((await res.json()).error).toBe("viabilidade_necessaria");
    } finally {
      await ctx.close();
    }
  });
});

describe("vagas do mapa x vagas da leitura", () => {
  // 8 saídas, 2 ocupadas: a leitura (Wiki) diz 6 vagas livres.
  const net = (mapFree?: number) => new MockNetworkMap([{ id: "caixa-9", name: "CTO-CRUZA", lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [1, 2], mapFree }]);
  const consulta = async (mapFree?: number) => {
    const ctx = await setup(net(mapFree));
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(a.atendente);
    const body = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
    return { ctx, cookie, cto: body.ctos[0], body };
  };

  it("mapa e leitura concordando oferecem as vagas", async () => {
    const { ctx, cto } = await consulta();
    try {
      expect(cto).toMatchObject({ blockedReason: null, vagas: 6, totalVagas: 8 });
    } finally {
      await ctx.close();
    }
  });

  it("a Wiki pode descontar do mapa (leitura com menos vagas que o mapa): continua à venda", async () => {
    const { ctx, cto } = await consulta(8);
    try {
      expect(cto).toMatchObject({ blockedReason: null, vagas: 6 });
    } finally {
      await ctx.close();
    }
  });

  it("leitura com mais vagas livres que o mapa é inconsistente: conferir e sem reserva", async () => {
    const { ctx, cookie, cto, body } = await consulta(3);
    try {
      expect(cto.blockedReason).toBe("conferir");
      expect(cto.vagas).toBe(0);
      expect(body.viable).toBe(false);
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoId: "caixa-9", address: ADDRESS });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("vaga_nao_confirmada");
    } finally {
      await ctx.close();
    }
  });
});
