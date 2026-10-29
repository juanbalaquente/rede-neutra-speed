import { describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { IntegrationError } from "../src/integrations/types.js";
import { WikiClientStatus } from "../src/integrations/wiki-client-status.js";

function build(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    return respond(url, init);
  };
  return { wiki: new WikiClientStatus(http, "https://wiki.exemplo/", "chave-leitura"), calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const STATUS = {
  login: "12345-JHV",
  fibra: { estado: "online", sinalDbm: -21.4, uptimeDesde: "2026-10-10T08:12:00-03:00", ultimaQuedaEm: null, atualizadoEm: "2026-10-16T10:02:00-03:00" },
  autenticacao: { estado: "conectado", ip: "100.64.12.34", desde: "2026-10-10T08:13:00-03:00", atualizadoEm: "2026-10-16T10:00:00-03:00" },
  contrato: { estado: "ativo", desde: "2026-09-30", atualizadoEm: "2026-10-16T10:01:00-03:00" },
  onu: { serial: "ZTEGC1234567", modelo: "F670L", olt: "OLT_SANTA_INES", vlan: 2500 },
};

describe("WikiClientStatus (contrato v3, seção A)", () => {
  it("lê com a chave de leitura e o código do parceiro, nunca com a de escrita", async () => {
    const { wiki, calls } = build(() => json(STATUS));
    const s = await wiki.status("12345-JHV", "JHV");
    expect(s).toMatchObject({ login: "12345-JHV", fibra: { estado: "online", sinalDbm: -21.4 }, onu: { vlan: 2500 } });
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v3/clientes/12345-JHV/status");
    expect(calls[0]!.headers["X-RedeNeutra-Key"]).toBe("chave-leitura");
    expect(calls[0]!.headers["X-RedeNeutra-Partner"]).toBe("JHV");
    expect(Object.keys(calls[0]!.headers)).not.toContain("X-RedeNeutra-Write-Key");
  });

  it("'consultar de novo' manda fresh=true; login desconhecido é null", async () => {
    const { wiki, calls } = build((url) => (url.includes("NOPE") ? json({ error: "login_desconhecido" }, 404) : json(STATUS)));
    await wiki.status("12345-JHV", "JHV", { fresh: true });
    expect(calls[0]!.url).toMatch(/status\?fresh=true$/);
    expect(await wiki.status("1-NOPE", "NOPE")).toBeNull();
  });

  it("o sentinela -99,99 nunca vira dBm", async () => {
    const { wiki } = build(() => json({ ...STATUS, fibra: { ...STATUS.fibra, estado: "loss", sinalDbm: -99.99 } }));
    expect((await wiki.status("12345-JHV", "JHV"))!.fibra.sinalDbm).toBeNull();
    const series = build(() =>
      json({ login: "12345-JHV", dias: 30, pontos: [{ em: "2026-10-01T00:00:00-03:00", rxDbm: -21 }, { em: "2026-10-01T06:00:00-03:00", rxDbm: -99.99 }], quedas: [] }),
    );
    expect((await series.wiki.signal("12345-JHV", "JHV", 30))!.pontos).toHaveLength(1);
  });

  it("fonte fora do ar chega como 'desconhecido' sem derrubar a resposta", async () => {
    const { wiki } = build(() => json({ ...STATUS, autenticacao: { estado: "desconhecido" }, contrato: { estado: "desconhecido" } }));
    const s = await wiki.status("12345-JHV", "JHV");
    expect(s!.autenticacao).toMatchObject({ estado: "desconhecido", ip: null });
    expect(s!.fibra.estado).toBe("online");
  });


  it("estado novo da Wiki vira 'desconhecido' sem derrubar a leitura; contrato ainda não aprovado é um estado conhecido", async () => {
    const { wiki } = build(() => json({ ...STATUS, fibra: { ...STATUS.fibra, estado: "em_manutencao" }, contrato: { estado: "pendente_aprovacao", desde: null, atualizadoEm: "2026-10-16T10:01:00-03:00" } }));
    const s = await wiki.status("12345-JHV", "JHV");
    expect(s!.fibra.estado).toBe("desconhecido");
    expect(s!.contrato.estado).toBe("pendente_aprovacao");
    expect(s!.autenticacao.estado).toBe("conectado"); // o resto da leitura segue valendo
    const lote = build(() => json({ clientes: [{ login: "1-JHV", fibra: "estado_novo", autenticacao: "conectado", contrato: "ativo", fibraEm: null, autenticacaoEm: null }] }));
    expect((await lote.wiki.summary(["1-JHV"], "JHV"))[0]!.fibra).toBe("desconhecido");
  });

  it("bloqueio da Speed na ONU: lê o campo `bloqueio` no status e no lote; sem o campo vale 'sem bloqueio'", async () => {
    const bloqueio = { ativo: true, desde: "2026-10-22T14:17:00.000Z", motivo: "inadimplência" };
    const blocked = build(() => json({ ...STATUS, fibra: { ...STATUS.fibra, estado: "desabilitada", sinalDbm: null }, bloqueio }));
    const s = await blocked.wiki.status("12345-JHV", "JHV");
    expect(s!.fibra.estado).toBe("desabilitada");
    expect(s!.bloqueio).toEqual(bloqueio);
    const old = build(() => json(STATUS));
    expect((await old.wiki.status("12345-JHV", "JHV"))!.bloqueio).toEqual({ ativo: false, desde: null, motivo: null });
    const lote = build(() => json({ clientes: [{ login: "1-JHV", fibra: "desabilitada", autenticacao: "desconectado", contrato: "ativo", fibraEm: null, autenticacaoEm: null, bloqueio }] }));
    expect((await lote.wiki.summary(["1-JHV"], "JHV"))[0]!.bloqueio?.ativo).toBe(true);
  });

  it("lote com mais de 200 logins vai em várias chamadas", async () => {
    const { wiki, calls } = build((_url, init) => {
      const { logins } = JSON.parse(init!.body as string) as { logins: string[] };
      return json({ clientes: logins.map((login) => ({ login, fibra: "online", autenticacao: "conectado", contrato: "ativo", fibraEm: null, autenticacaoEm: null })) });
    });
    const out = await wiki.summary(Array.from({ length: 450 }, (_, i) => `${i}-JHV`), "JHV");
    expect(out).toHaveLength(450);
    expect(calls.map((c) => JSON.parse(c.body!).logins.length)).toEqual([200, 200, 50]);
    expect(calls[0]!.method).toBe("POST");
  });

  it("diagnóstico da ONU (seção I): lê, limpa o sentinela e separa login desconhecido de rota ausente", async () => {
    const ONU = {
      login: "12345-JHV",
      lidoEm: "2026-10-22T15:04:00-03:00",
      onu: { serial: "HWTC6FE1FCB2", modelo: "EG8145X6", estado: "online", olt: "OLT_BACKBONE_CENTRAL", slot: 1, pon: 15, rxDbm: -21.4, txDbm: 2.1, rxOltDbm: -99.99, temperaturaC: 48, distanciaM: 1830, ligadaDesde: null, ultimaQuedaEm: null, sinalLidoEm: null },
      pon: { onus: 42, offline: 3, mediaRxDbm: -20.9 },
      wifi: { online: true, lidoEm: null, dispositivos: [{ nome: null, mac: "AA:BB:CC:DD:EE:01", banda: "5GHz", ssid: "CASA", rssiDbm: -58 }] },
    };
    const { wiki, calls } = build(() => json(ONU));
    const d = await wiki.onu("12345-JHV", "JHV");
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v3/clientes/12345-JHV/onu");
    expect(calls[0]!.headers["X-RedeNeutra-Partner"]).toBe("JHV");
    expect(d!.onu).toMatchObject({ rxDbm: -21.4, rxOltDbm: null, distanciaM: 1830 });
    expect(d!.wifi!.dispositivos[0]).toMatchObject({ online: true, nome: null });

    const minimal = build(() => json({ login: "1-JHV", onu: { serial: "X", estado: "loss" } }));
    expect(await minimal.wiki.onu("1-JHV", "JHV")).toMatchObject({ pon: null, wifi: null, onu: { rxDbm: null, slot: null } });

    expect(await build(() => json({ error: "login_desconhecido" }, 404)).wiki.onu("1-JHV", "JHV")).toBeNull();
    const missing = build(() => new Response("404 Not Found", { status: 404 }));
    await expect(missing.wiki.onu("1-JHV", "JHV")).rejects.toMatchObject({ status: 404 });
  });

  it("o lote traz o sinal quando a Wiki manda, e nulo quando não manda", async () => {
    const { wiki } = build(() =>
      json({ clientes: [
        { login: "1-JHV", fibra: "online", autenticacao: "conectado", contrato: "ativo", fibraEm: null, autenticacaoEm: null, sinalDbm: -20.5 },
        { login: "2-JHV", fibra: "loss", autenticacao: "desconectado", contrato: "ativo", fibraEm: null, autenticacaoEm: null, sinalDbm: -99.99 },
        { login: "3-JHV", fibra: "online", autenticacao: "conectado", contrato: "ativo", fibraEm: null, autenticacaoEm: null },
      ] }),
    );
    expect((await wiki.summary(["1-JHV", "2-JHV", "3-JHV"], "JHV")).map((c) => c.sinalDbm)).toEqual([-20.5, null, null]);
  });

  it("resposta fora do contrato e erro 5xx viram IntegrationError", async () => {
    const bad = build(() => json({ login: "x", fibra: { estado: "quase-online" } }));
    await expect(bad.wiki.status("12345-JHV", "JHV")).rejects.toThrow(/fora do contrato v3/);
    const down = build(() => json({ error: "boom" }, 503));
    await expect(down.wiki.status("12345-JHV", "JHV")).rejects.toBeInstanceOf(IntegrationError);
    const limited = build(() => json({ error: "fila_cheia" }, 429));
    await expect(limited.wiki.status("12345-JHV", "JHV", { fresh: true })).rejects.toMatchObject({ status: 429 });
  });
});
