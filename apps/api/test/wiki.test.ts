import { describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { IntegrationError, type CtoPorts, type NetworkMap } from "../src/integrations/types.js";
import { WikiNetworkMap } from "../src/integrations/wiki.js";
import { setup } from "./helpers.js";

function fakeHttp(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return respond(url, init);
  };
  return { http, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const NEARBY = {
  point: { lat: -19.9, lng: -43.9 },
  ctos: [{ ctoId: "box-17", name: "CTO-X", distanceM: 120, freePorts: 3, usagePct: 80, location: { lat: -19.9, lng: -43.9 } }],
};
const PORTS = {
  ctoId: "box-17",
  name: "CTO-X",
  totalPorts: 4,
  confidence: "confirmada",
  ports: [
    { port: 1, state: "livre" },
    { port: 2, state: "ocupada" },
    { port: 3, state: "desconhecida" },
    { port: 4, state: "livre" },
  ],
};

describe("WikiNetworkMap", () => {
  it("chama /proxy/redeneutra/v1 com a chave e devolve CTOs com id", async () => {
    const { http, calls } = fakeHttp(() => json(NEARBY));
    const wiki = new WikiNetworkMap(http, "https://wiki.exemplo/", "chave-de-teste");
    const r = await wiki.findNearbyCtos("Rua A, 10, BH", 300);
    expect(r.ctos[0]?.ctoId).toBe("box-17");
    const call = calls[0]!;
    expect(call.url.startsWith("https://wiki.exemplo/proxy/redeneutra/v1/viabilidade?")).toBe(true);
    expect(new URL(call.url).searchParams.get("raio")).toBe("300");
    expect(call.headers["X-RedeNeutra-Key"]).toBe("chave-de-teste");
  });

  it("lê portas com três estados e usa o id codificado na URL", async () => {
    const { http, calls } = fakeHttp(() => json(PORTS));
    const wiki = new WikiNetworkMap(http, "https://wiki.exemplo", "k");
    const ports = await wiki.getCtoPorts("box/17");
    expect(ports?.ports.map((p) => p.state)).toEqual(["livre", "ocupada", "desconhecida", "livre"]);
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v1/ctos/box%2F17/portas");
  });

  it("404 em portas vira null", async () => {
    const wiki = new WikiNetworkMap(fakeHttp(() => json({}, 404)).http, "https://wiki.exemplo", "k");
    expect(await wiki.getCtoPorts("nao-existe")).toBeNull();
  });

  it("resposta fora do contrato vira erro, não palpite", async () => {
    const bad = { ...PORTS, ports: [{ port: 1, state: "talvez" }] };
    const wiki = new WikiNetworkMap(fakeHttp(() => json(bad)).http, "https://wiki.exemplo", "k");
    await expect(wiki.getCtoPorts("box-17")).rejects.toThrow(IntegrationError);
    const noId = { point: null, ctos: [{ name: "CTO-X", distanceM: 1, freePorts: 1, usagePct: null, location: null }] };
    const wiki2 = new WikiNetworkMap(fakeHttp(() => json(noId)).http, "https://wiki.exemplo", "k");
    await expect(wiki2.findNearbyCtos("Rua A, 10, BH", 300)).rejects.toThrow(/contrato v1/);
  });

  it("erro HTTP da Wiki vira IntegrationError com o status", async () => {
    const wiki = new WikiNetworkMap(fakeHttp(() => json({}, 401)).http, "https://wiki.exemplo", "k");
    await expect(wiki.findNearbyCtos("Rua A, 10, BH", 300)).rejects.toMatchObject({ system: "wiki", status: 401 });
  });
});

/** Rede de teste: uma CTO "conferir" e outra com porta de estado desconhecido. */
class FragileNetwork implements NetworkMap {
  private readonly base = new MockNetworkMap();
  findNearbyCtos(address: string, radiusM: number) {
    return this.base.findNearbyCtos(address, radiusM);
  }
  async getCtoPorts(ctoId: string): Promise<CtoPorts | null> {
    const cto = await this.base.getCtoPorts(ctoId);
    if (!cto) return null;
    if (ctoId === "CTO-TESTE-03") return { ...cto, confidence: "conferir" };
    if (ctoId === "CTO-TESTE-01") return { ...cto, ports: cto.ports.map((p) => (p.port === 4 ? { ...p, state: "desconhecida" as const } : p)) };
    return cto;
  }
}

describe("dado fraco nunca vira porta livre", () => {
  it("CTO 'conferir' não oferece porta e não aceita reserva", async () => {
    const ctx = await setup(new FragileNetwork());
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      const body = await (await ctx.call(cookie, "POST", "/viability", { address: "Rua dos Testes, 100, Belo Horizonte" })).json();
      const cto3 = body.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-03");
      expect(cto3.blockedReason).toBe("conferir");
      expect(cto3.freePorts).toEqual([]);
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoName: "CTO-TESTE-03", port: 1, address: "Rua dos Testes, 100, BH" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("porta_nao_confirmada");
    } finally {
      await ctx.close();
    }
  });

  it("porta 'desconhecida' fica fora da lista e não pode ser reservada", async () => {
    const ctx = await setup(new FragileNetwork());
    try {
      const a = await ctx.createPartner("A", "11111111000111");
      const cookie = await ctx.login(a.atendente);
      const body = await (await ctx.call(cookie, "POST", "/viability", { address: "Rua dos Testes, 100, Belo Horizonte" })).json();
      const cto1 = body.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-01");
      expect(cto1.freePorts).not.toContain(4);
      expect(cto1.freePorts).toContain(6);
      const res = await ctx.call(cookie, "POST", "/reservations", { ctoName: "CTO-TESTE-01", port: 4, address: "Rua dos Testes, 100, BH" });
      expect((await res.json()).error).toBe("porta_nao_confirmada");
    } finally {
      await ctx.close();
    }
  });
});
