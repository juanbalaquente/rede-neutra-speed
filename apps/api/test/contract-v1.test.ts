import { describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import type { CtoPorts, NetworkMap } from "../src/integrations/types.js";
import { WikiNetworkMap } from "../src/integrations/wiki.js";
import { setup } from "./helpers.js";

const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const wikiWith = (respond: (url: string) => Response) => {
  const urls: string[] = [];
  const http: Http = async (url) => {
    urls.push(url);
    return respond(url);
  };
  return { wiki: new WikiNetworkMap(http, "https://wiki.exemplo", "k"), urls };
};
const mockCto = (extra: Record<string, unknown>) => ({ id: "c1", name: "CTO-X", lat: -19.9191, lng: -43.9386, totalPorts: 8, occupied: [1, 2], ...extra });

describe("cliente da Wiki: ajustes A a D", () => {
  it("A e B: freePorts, ctoId nulos e proximaAmbigua são aceitos, sem virar zero", async () => {
    const { wiki } = wikiWith(() =>
      json({
        point: null,
        ctos: [
          { ctoId: null, name: "CTO-AMBIGUA", distanceM: 10, freePorts: null, usagePct: null, location: null, proximaAmbigua: true },
          { ctoId: "9", name: "CTO-OK", distanceM: 20, freePorts: 2, usagePct: 50, location: null },
        ],
      }),
    );
    const r = await wiki.findNearbyCtos("Rua A, 10, BH", 300);
    expect(r.ctos[0]).toMatchObject({ ctoId: null, freePorts: null, proximaAmbigua: true });
    expect(r.ctos[1]?.proximaAmbigua).toBe(false);
  });

  it("C: lê updatedAt e motivos; updatedAt ilegível ou ausente é erro de contrato", async () => {
    const ports = { ctoId: "1", name: "X", totalPorts: 1, confidence: "conferir", updatedAt: "2026-10-07T10:00:00Z", motivos: ["gemea_total_diferente"], ports: [{ port: 1, state: "livre" }] };
    const ok = await wikiWith(() => json(ports)).wiki.getCtoPorts("1");
    expect(ok).toMatchObject({ confidence: "conferir", motivos: ["gemea_total_diferente"] });
    await expect(wikiWith(() => json({ ...ports, updatedAt: "ontem" })).wiki.getCtoPorts("1")).rejects.toThrow(/contrato v1/);
    const { updatedAt: _omit, ...semData } = ports;
    await expect(wikiWith(() => json(semData)).wiki.getCtoPorts("1")).rejects.toThrow(/contrato v1/);
  });

  it("fresh=true vai na URL só quando pedido", async () => {
    const ports = { ctoId: "1", name: "X", totalPorts: 1, confidence: "fontes_concordam", updatedAt: "2026-10-07T10:00:00Z", ports: [{ port: 1, state: "livre" }] };
    const { wiki, urls } = wikiWith(() => json(ports));
    await wiki.getCtoPorts("1");
    await wiki.getCtoPorts("1", { fresh: true });
    expect(urls[0]).toMatch(/portas$/);
    expect(urls[1]).toMatch(/portas\?fresh=true$/);
  });

  it("D: health separa ok, chave recusada e Wiki fora do ar, sem lançar", async () => {
    expect((await wikiWith(() => json({ ok: true })).wiki.health()).ok).toBe(true);
    const denied = await wikiWith(() => json({}, 401)).wiki.health();
    expect(denied.ok).toBe(false);
    expect(denied.detail).toMatch(/chave recusada/);
    expect((await wikiWith(() => json({}, 503)).wiki.health()).ok).toBe(false);
    const down = new WikiNetworkMap(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      "https://wiki.exemplo",
      "k",
    );
    expect(await down.health()).toMatchObject({ ok: false, detail: "ECONNREFUSED" });
  });
});

describe("viabilidade com o contrato revisado", () => {
  async function viability(network: NetworkMap, who: "partner" | "admin" = "partner") {
    const ctx = await setup(network);
    const a = await ctx.createPartner("A", "11111111000111");
    const cookie = await ctx.login(who === "admin" ? "admin@speed.test" : a.atendente);
    const body = await (await ctx.call(cookie, "POST", "/viability", { address: ADDRESS })).json();
    return { ctx, cookie, body, cto: body.ctos[0] };
  }

  it("ctoId nulo: aparece, não vende, não reserva e a consulta fica registrada", async () => {
    const { ctx, cookie, body, cto } = await viability(new MockNetworkMap([mockCto({ unresolved: true })]));
    try {
      expect(cto).toMatchObject({ ctoId: null, blockedReason: "conferir", freePorts: [] });
      expect(body.viable).toBe(false);
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoId: "c1", port: 3, address: ADDRESS });
      expect(res.status).toBe(422);
    } finally {
      await ctx.close();
    }
  });

  it("freePorts nulo no mapa vira conferir, não zero nem divergência numérica", async () => {
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

  it("CTO que sumiu da leitura (id recriado) é conferir, não erro", async () => {
    class Recreated extends MockNetworkMap {
      async getCtoPorts(): Promise<CtoPorts | null> {
        return null;
      }
    }
    const { ctx, cto } = await viability(new Recreated([mockCto({})]));
    try {
      expect(cto.blockedReason).toBe("conferir");
    } finally {
      await ctx.close();
    }
  });
});

describe("reserva com leitura fresca", () => {
  it("pede fresh=true e responde porta_nao_confirmada se a caixa sumiu ou o dado é velho", async () => {
    const calls: { fresh?: boolean }[] = [];
    class Spy extends MockNetworkMap {
      mode: "ok" | "gone" | "old" = "ok";
      async getCtoPorts(id: string, opts?: { fresh?: boolean }) {
        calls.push({ fresh: opts?.fresh });
        if (this.mode === "gone") return null;
        const p = await super.getCtoPorts(id);
        return p && this.mode === "old" ? { ...p, updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() } : p;
      }
    }
    const net = new Spy([mockCto({ occupied: [] })]);
    const ctx = await setup(net);
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
      const reserve = (port: number) => ctx.call(cookie, "POST", "/reservations", { ctoId: "c1", port, address: ADDRESS });

      net.mode = "gone";
      expect((await (await reserve(1)).json()).error).toBe("porta_nao_confirmada");
      net.mode = "old";
      expect((await (await reserve(1)).json()).error).toBe("porta_nao_confirmada");
      net.mode = "ok";
      expect((await reserve(1)).status).toBe(201);
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
