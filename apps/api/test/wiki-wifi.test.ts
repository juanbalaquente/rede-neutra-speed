import { describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { IntegrationError } from "../src/integrations/types.js";
import { OperationRefused, WikiCustomerActions } from "../src/integrations/wiki-actions.js";
import { WikiClientStatus } from "../src/integrations/wiki-client-status.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const REQ = { login: "10001-JHV", partnerCode: "JHV", ssid: "Casa do Joao", senha: "Segredo-Wifi-9876" };

/** O cliente comum (15 s) nunca pode ser usado para o Wi-Fi: só o de 75 s (maior que os 45 s da Wiki mais a conferência dela). */
function build(respond: () => Response) {
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const wifiHttp: Http = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string });
    return respond();
  };
  const common: Http = async () => {
    throw new Error("Wi-Fi não pode usar o cliente de 15 s");
  };
  return { svc: new WikiCustomerActions(common, "https://wiki.exemplo/", "chave-escrita", wifiHttp), calls };
}

describe("WikiCustomerActions.setWifi (contrato v3, seção J)", () => {
  it("manda chave de escrita, parceiro e corpo só com nome e senha; lê o nome de volta", async () => {
    const { svc, calls } = build(() => json({ aplicado: true, ssid: "Casa do Joao" }));
    expect(await svc.setWifi(REQ)).toEqual({ ssid: "Casa do Joao", ssid5: null });
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v3/clientes/10001-JHV/wifi");
    expect(calls[0]!.headers["X-RedeNeutra-Write-Key"]).toBe("chave-escrita");
    expect(calls[0]!.headers["X-RedeNeutra-Partner"]).toBe("JHV");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ssid: "Casa do Joao", senha: "Segredo-Wifi-9876" });
  });

  it.each([
    [409, "onu_offline"],
    [409, "cliente_bloqueado"],
    [422, "senha_invalida"],
    [422, "senha_fraca"],
    [403, "login_de_outro_parceiro"],
    [429, "limite_de_trocas"],
    [502, "falha_no_aparelho"],
    [503, "wifi_desligado"],
  ])("%i %s vira recusa de negócio com o código", async (status, error) => {
    const { svc } = build(() => json({ error }, status));
    await expect(svc.setWifi(REQ)).rejects.toMatchObject({ code: error, status });
  });

  it("a rede 5 GHz vem com nome próprio (ssid5, 29 out 2026)", async () => {
    const { svc } = build(() => json({ aplicado: true, ssid: "teste", ssid5: "teste_5G" }));
    expect(await svc.setWifi(REQ)).toEqual({ ssid: "teste", ssid5: "teste_5G" });
  });

  it("404 vira login_desconhecido", async () => {
    const { svc } = build(() => json({ error: "login_desconhecido" }, 404));
    await expect(svc.setWifi(REQ)).rejects.toBeInstanceOf(OperationRefused);
  });

  it("504 e 502 sem código são 'sem confirmação', não recusa", async () => {
    for (const status of [504, 502]) {
      const { svc } = build(() => new Response("bad gateway", { status }));
      await expect(svc.setWifi(REQ)).rejects.toBeInstanceOf(IntegrationError);
    }
  });

  it("resposta sem aplicado:true é fora do contrato, não sucesso", async () => {
    const { svc } = build(() => json({ aplicado: false, ssid: null }));
    await expect(svc.setWifi(REQ)).rejects.toBeInstanceOf(IntegrationError);
  });

  it("a senha não aparece na mensagem de nenhum erro", async () => {
    for (const make of [() => json({ error: "senha_invalida" }, 422), () => new Response("x", { status: 504 })]) {
      const { svc } = build(make);
      const e = await svc.setWifi(REQ).catch((x: Error) => x);
      expect(String((e as Error).message)).not.toContain(REQ.senha);
    }
  });
});

describe("WikiClientStatus.wifiLastChange (ultima-troca)", () => {
  const build = (respond: () => Response) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const http: Http = async (url, init) => {
      calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return respond();
    };
    return { svc: new WikiClientStatus(http, "https://wiki.exemplo/", "chave-leitura"), calls };
  };
  const ok = { estado: "aplicado", banda: null, motivo: null, ssid: "Casa", duracaoMs: 33903, atualizadoEm: "2026-10-26T13:28:03.181Z" };

  it("usa a chave de LEITURA e o parceiro, e valida a resposta", async () => {
    const { svc, calls } = build(() => json(ok));
    expect(await svc.wifiLastChange("10001-JHV", "JHV")).toMatchObject({ estado: "aplicado", ssid: "Casa", duracaoMs: 33903 });
    expect(calls[0]!.url).toBe("https://wiki.exemplo/proxy/redeneutra/v3/clientes/10001-JHV/wifi/ultima-troca");
    expect(calls[0]!.headers["X-RedeNeutra-Key"]).toBe("chave-leitura");
    expect(calls[0]!.headers["X-RedeNeutra-Partner"]).toBe("JHV");
    expect(calls[0]!.headers["X-RedeNeutra-Write-Key"]).toBeUndefined();
  });

  it("404 (sem_troca_registrada) vira null", async () => {
    const { svc } = build(() => json({ error: "sem_troca_registrada" }, 404));
    expect(await svc.wifiLastChange("10001-JHV", "JHV")).toBeNull();
  });

  it("estado fora do contrato é erro, não resultado", async () => {
    const { svc } = build(() => json({ ...ok, estado: "talvez" }));
    await expect(svc.wifiLastChange("10001-JHV", "JHV")).rejects.toBeInstanceOf(IntegrationError);
  });
});
