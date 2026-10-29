import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import { WikiNetworkMap } from "../src/integrations/wiki.js";
import { setup } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

beforeEach(async () => {
  ctx = await setup(new MockNetworkMap());
});
afterEach(async () => {
  await ctx.close();
});

describe("mapa por sigla (rota do admin)", () => {
  it("mostra a rede inteira da sigla, com estado de cada CTO e totais", async () => {
    const adm = await ctx.login("admin@speed.test");
    const res = await ctx.call(adm, "GET", "/admin/painel/regioes/ita");
    expect(res.status).toBe(200);
    const map = await res.json();
    expect(map.regiao).toBe("ITA");
    expect(map.totais).toMatchObject({ ctos: 3, comVaga: 2, semVaga: 1, conferir: 0, semLocalizacao: 0 });
    expect(map.ctos.map((c: { name: string; estado: string }) => `${c.name}:${c.estado}`)).toEqual(["CTO-TESTE-01:com_vaga", "CTO-TESTE-02:sem_vaga", "CTO-TESTE-03:com_vaga"]);
    expect(map.ctos[0].location).toMatchObject({ lat: expect.any(Number) });
  });

  it("conta as reservas abertas do portal em cada CTO", async () => {
    const a = await ctx.createPartner("JHV Telecom", "11111111000111", { code: "JHV", maxCtoOccupancyPct: 100 });
    const cookie = await ctx.login(a.atendente);
    await ctx.call(cookie, "POST", "/viability", { address: "Rua dos Testes, 100, Belo Horizonte" });
    await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: "Rua dos Testes, 100, Belo Horizonte" });
    const map = await (await ctx.call(await ctx.login("admin@speed.test"), "GET", "/admin/painel/regioes/ITA")).json();
    expect(map.ctos.find((c: { name: string }) => c.name === "CTO-TESTE-01").reservasAbertas).toBe(1);
  });

  it("sigla desconhecida é 404, sigla inválida é 400 e só a Speed vê", async () => {
    const adm = await ctx.login("admin@speed.test");
    expect((await ctx.call(adm, "GET", "/admin/painel/regioes/ZZZ")).status).toBe(404);
    expect((await ctx.call(adm, "GET", "/admin/painel/regioes/a-b")).status).toBe(400);
    const a = await ctx.createPartner("JHV Telecom", "11111111000111", { code: "JHV" });
    expect((await ctx.call(await ctx.login(a.supervisor), "GET", "/admin/painel/regioes/ITA")).status).toBe(403);
  });
});

describe("WikiNetworkMap.getRegionCtos (v1.1)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const build = (respond: (url: string) => Response) => {
    const urls: string[] = [];
    const http: Http = async (url) => {
      urls.push(url);
      return respond(url);
    };
    return { wiki: new WikiNetworkMap(http, "https://wiki.exemplo/", "chave"), urls };
  };
  const CTO = { ctoId: "24109", name: "CTO_03_ITA_X", regiao: "ITA", vagasLivres: 3, totalVagas: 16, confidence: "fontes_concordam", updatedAt: "2026-10-16T10:00:00-03:00", motivos: [], location: { lat: -19.9, lng: -43.9 } };

  it("lê /regioes/{sigla}/ctos e aceita CTO sem localização", async () => {
    const { wiki, urls } = build(() => json({ regiao: "ITA", atualizadoEm: "2026-10-16T10:00:00-03:00", ctos: [CTO, { ...CTO, ctoId: "1", location: null }] }));
    const map = await wiki.getRegionCtos("ITA");
    expect(urls[0]).toBe("https://wiki.exemplo/proxy/redeneutra/v1/regioes/ITA/ctos");
    expect(map!.ctos).toHaveLength(2);
    expect(map!.ctos[1]!.location).toBeNull();
  });

  it("sigla desconhecida é null; resposta fora do contrato é erro", async () => {
    expect(await build(() => json({ error: "regiao_desconhecida" }, 404)).wiki.getRegionCtos("ZZZ")).toBeNull();
    const bad = build(() => json({ regiao: "ITA", ctos: [{ ctoId: "1" }] }));
    await expect(bad.wiki.getRegionCtos("ITA")).rejects.toThrow(/fora do contrato v1/);
  });
});
