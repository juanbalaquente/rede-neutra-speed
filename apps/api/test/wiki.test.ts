import { describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { IntegrationError } from "../src/integrations/types.js";
import { WikiNetworkMap } from "../src/integrations/wiki.js";

function fakeHttp(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return respond(url, init);
  };
  return { http, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const wikiWith = (respond: (url: string) => Response) => {
  const f = fakeHttp(respond);
  return { wiki: new WikiNetworkMap(f.http, "https://wiki.exemplo/", "chave-de-teste"), calls: f.calls };
};

const NEARBY = {
  point: { lat: -19.9, lng: -43.9 },
  ctos: [{ ctoId: "17342", name: "CTO_01_ITA_X", distanceM: 120, freePorts: 3, usagePct: 80, location: { lat: -19.9, lng: -43.9 }, regiao: "ITA" }],
};
const VAGAS = {
  ctoId: "17342",
  name: "CTO_01_ITA_X",
  regiao: "ITA",
  vagasLivres: 4,
  totalVagas: 16,
  confidence: "fontes_concordam",
  updatedAt: "2026-10-07T14:00:00-03:00",
  motivos: [],
};

describe("WikiNetworkMap", () => {
  it("chama /proxy/redeneutra/v1 com a chave e devolve CTOs com id do Codemaps e região", async () => {
    const { wiki, calls } = wikiWith(() => json(NEARBY));
    const r = await wiki.findNearbyCtos("Rua A, 10, Sabará", 300);
    expect(r.ctos[0]).toMatchObject({ ctoId: "17342", regiao: "ITA" });
    const call = calls[0]!;
    expect(call.url.startsWith("https://wiki.exemplo/proxy/redeneutra/v1/viabilidade?")).toBe(true);
    expect(new URL(call.url).searchParams.get("raio")).toBe("300");
    expect(call.headers["X-RedeNeutra-Key"]).toBe("chave-de-teste");
  });

  it("lê as vagas (sem lista de portas) e codifica o id na URL", async () => {
    const { wiki, calls } = wikiWith(() => json(VAGAS));
    const v = await wiki.getCtoVagas("17/342");
    expect(v).toMatchObject({ vagasLivres: 4, totalVagas: 16, regiao: "ITA", confidence: "fontes_concordam" });
    expect(v).not.toHaveProperty("ports");
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v1/ctos/17%2F342/vagas");
  });

  it("fresh=true vai na URL só quando pedido", async () => {
    const { wiki, calls } = wikiWith(() => json(VAGAS));
    await wiki.getCtoVagas("1");
    await wiki.getCtoVagas("1", { fresh: true });
    expect(calls[0]!.url).toMatch(/vagas$/);
    expect(calls[1]!.url).toMatch(/vagas\?fresh=true$/);
  });

  it("404 em vagas vira null (sem caixa no OLTCloud ou inexistente)", async () => {
    const { wiki } = wikiWith(() => json({}, 404));
    expect(await wiki.getCtoVagas("nao-existe")).toBeNull();
  });

  it("freePorts, ctoId e regiao nulos são aceitos, sem virar zero; proximaAmbigua ausente vale false", async () => {
    const { wiki } = wikiWith(() =>
      json({
        point: null,
        ctos: [
          { ctoId: null, name: "SEM-ID", distanceM: 10, freePorts: null, usagePct: null, location: null, regiao: null, proximaAmbigua: true },
          { ctoId: "9", name: "OK", distanceM: 20, freePorts: 2, usagePct: 50, location: null },
        ],
      }),
    );
    const r = await wiki.findNearbyCtos("Rua A, 10, BH", 300);
    expect(r.ctos[0]).toMatchObject({ ctoId: null, freePorts: null, regiao: null, proximaAmbigua: true });
    expect(r.ctos[1]).toMatchObject({ regiao: null, proximaAmbigua: false });
  });

  it("resposta fora do contrato vira erro, não palpite", async () => {
    const bad = (patch: Record<string, unknown>) => wikiWith(() => json({ ...VAGAS, ...patch })).wiki.getCtoVagas("17342");
    await expect(bad({ confidence: "confirmada" })).rejects.toThrow(IntegrationError); // nome antigo
    await expect(bad({ vagasLivres: -1 })).rejects.toThrow(/contrato v1/);
    await expect(bad({ totalVagas: undefined })).rejects.toThrow(/contrato v1/);
    await expect(bad({ updatedAt: "ontem" })).rejects.toThrow(/contrato v1/);
    await expect(bad({ updatedAt: undefined })).rejects.toThrow(/contrato v1/);
    const noId = { point: null, ctos: [{ name: "X", distanceM: 1, freePorts: 1, usagePct: null, location: null }] };
    await expect(wikiWith(() => json(noId)).wiki.findNearbyCtos("Rua A, 10, BH", 300)).rejects.toThrow(/contrato v1/);
  });

  it("erro HTTP da Wiki vira IntegrationError com o status", async () => {
    const { wiki } = wikiWith(() => json({}, 401));
    await expect(wiki.findNearbyCtos("Rua A, 10, BH", 300)).rejects.toMatchObject({ system: "wiki", status: 401 });
  });

  it("health separa ok, chave recusada e Wiki fora do ar, sem lançar", async () => {
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
