import { describe, expect, it } from "vitest";
import { MockNetworkMap } from "../src/integrations/mock.js";
import type { CtoVagas, NetworkMap } from "../src/integrations/types.js";
import { setup } from "./helpers.js";

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const mockCto = (extra: Record<string, unknown>) => ({ id: "c1", name: "CTO-X", lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [1, 2], ...extra });

/** Consulta de viabilidade com a rede dada, como parceiro (padrão) ou administrador Speed. */
async function viability(network: NetworkMap, who: "partner" | "admin" = "partner") {
  const ctx = await setup(network);
  const a = await ctx.createPartner("A", "11111111000111");
  const cookie = await ctx.login(who === "admin" ? "admin@speed.test" : a.atendente);
  const body = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
  return { ctx, cookie, body, cto: body.ctos[0] };
}

describe("CTO que não vende, mas aparece", () => {
  it("ctoId nulo: aparece, não vende, não reserva e a consulta fica registrada", async () => {
    const { ctx, cookie, body, cto } = await viability(new MockNetworkMap([mockCto({ unresolved: true })]));
    try {
      expect(cto).toMatchObject({ ctoId: null, blockedReason: "conferir", vagas: 0 });
      expect(body.viable).toBe(false);
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoId: "c1", address: ADDRESS });
      expect(res.status).toBe(422);
    } finally {
      await ctx.close();
    }
  });

  it("freePorts nulo no mapa vira conferir, nunca zero", async () => {
    const { ctx, cto } = await viability(new MockNetworkMap([mockCto({ mapFree: null })]));
    try {
      expect(cto.blockedReason).toBe("conferir");
    } finally {
      await ctx.close();
    }
  });

  it("dado com mais de 1 h vira conferir; com 10 min vende", async () => {
    const velho = await viability(new MockNetworkMap([mockCto({ ageMinutes: 90 })]), "admin");
    const novo = await viability(new MockNetworkMap([mockCto({ ageMinutes: 10 })]));
    try {
      expect(velho.cto.blockedReason).toBe("conferir");
      expect(velho.cto.motivos).toContain("dado_antigo");
      expect(novo.cto.blockedReason).toBeNull();
    } finally {
      await velho.ctx.close();
      await novo.ctx.close();
    }
  });

  it("CTO sem caixa no OLTCloud (leitura devolve null) é conferir, não erro", async () => {
    class SemCaixa extends MockNetworkMap {
      async getCtoVagas(): Promise<CtoVagas | null> {
        return null;
      }
    }
    const { ctx, cto } = await viability(new SemCaixa([mockCto({})]), "admin");
    try {
      expect(cto.blockedReason).toBe("conferir");
      expect(cto.motivos).toEqual(["sem_caixa_oltcloud"]);
    } finally {
      await ctx.close();
    }
  });

  it("proximaAmbigua chega ao parceiro, mas os motivos técnicos só à Speed", async () => {
    const net = () => new MockNetworkMap([mockCto({ ambiguous: true, confidence: "conferir", motivos: ["nome_repetido"] })]);
    const parceiro = await viability(net());
    const speed = await viability(net(), "admin");
    try {
      expect(parceiro.cto).toMatchObject({ proximaAmbigua: true, blockedReason: "conferir", motivos: [] });
      expect(speed.cto.motivos).toEqual(["nome_repetido"]);
    } finally {
      await parceiro.ctx.close();
      await speed.ctx.close();
    }
  });

  it("motivo informativo não bloqueia: a CTO vende e só a Speed vê o motivo", async () => {
    const net = () => new MockNetworkMap([mockCto({ motivos: ["oltcloud_mais_clientes_que_desenho"] })]);
    const parceiro = await viability(net());
    const speed = await viability(net(), "admin");
    try {
      expect(parceiro.cto).toMatchObject({ blockedReason: null, vagas: 6, motivos: [] });
      expect(speed.cto.motivos).toEqual(["oltcloud_mais_clientes_que_desenho"]);
    } finally {
      await parceiro.ctx.close();
      await speed.ctx.close();
    }
  });
});

describe("área por sigla", () => {
  it("sigla ausente (nome fora do padrão) nunca é oferecida ao parceiro", async () => {
    const { ctx, body } = await viability(new MockNetworkMap([mockCto({ regiao: null })]));
    try {
      expect(body.ctos).toHaveLength(0);
      expect(body.foraDaArea).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("siglas misturadas: só as liberadas aparecem e ocupam as 5 vagas de lista", async () => {
    const net = new MockNetworkMap([
      mockCto({ id: "fora", name: "CTO-FORA", regiao: "XYZ" }),
      mockCto({ id: "dentro", name: "CTO-DENTRO", regiao: "ita" }),
    ]);
    const { ctx, body } = await viability(net);
    try {
      expect(body.ctos.map((c: { ctoId: string }) => c.ctoId)).toEqual(["dentro"]);
      expect(body.foraDaArea).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});

describe("reserva com leitura fresca", () => {
  it("pede fresh=true e responde vaga_nao_confirmada se a caixa sumiu ou o dado é velho", async () => {
    const calls: { fresh?: boolean }[] = [];
    class Spy extends MockNetworkMap {
      mode: "ok" | "gone" | "old" = "ok";
      async getCtoVagas(id: string, opts?: { fresh?: boolean }) {
        calls.push({ fresh: opts?.fresh });
        if (this.mode === "gone") return null;
        const v = await super.getCtoVagas(id);
        return v && this.mode === "old" ? { ...v, updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() } : v;
      }
    }
    const net = new Spy([mockCto({ occupied: [] })]);
    const ctx = await setup(net);
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
      const reserve = () => ctx.call(cookie, "POST", "/reservations", { ctoId: "c1", address: ADDRESS });

      net.mode = "gone";
      expect((await (await reserve()).json()).error).toBe("vaga_nao_confirmada");
      net.mode = "old";
      expect((await (await reserve()).json()).error).toBe("vaga_nao_confirmada");
      net.mode = "ok";
      expect((await reserve()).status).toBe(201);
      expect(calls.at(-1)).toEqual({ fresh: true });
    } finally {
      await ctx.close();
    }
  });
});

describe("GET /admin/integrations/health", () => {
  it("só o administrador Speed vê o estado da integração", async () => {
    const ctx = await setup();
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      expect((await ctx.call(await ctx.login(a.supervisor), "GET", "/admin/integrations/health")).status).toBe(403);
      const res = await ctx.call(await ctx.login("admin@speed.test"), "GET", "/admin/integrations/health");
      expect(await res.json()).toMatchObject({ mode: "mock", ok: true });
    } finally {
      await ctx.close();
    }
  });
});
