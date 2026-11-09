import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttp, type ApiCallRecord } from "../src/integrations/http.js";
import { IntegrationError } from "../src/integrations/types.js";

/** Erro como o fetch do Node devolve quando o DNS não responde: "fetch failed" com a causa em `cause`. */
const dnsFailure = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(responses: (Response | Error)[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next!;
  });
  const logs: ApiCallRecord[] = [];
  const http = createHttp("wiki", (r) => logs.push(r), 1_000, { retryDelayMs: 1 });
  return { http, calls, logs };
}

describe("cliente HTTP das integrações", () => {
  it("leitura que falha na rede é repetida uma vez e passa; as duas tentativas ficam no log com a causa", async () => {
    const { http, calls, logs } = setup([dnsFailure(), new Response("{}", { status: 200 })]);
    const res = await http("https://wiki.exemplo/proxy/redeneutra/v1/health");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(logs.map((l) => l.error)).toEqual(["fetch failed (EAI_AGAIN)", null]);
  });

  it("se a repetição também falha, o erro chega com a causa", async () => {
    const { http, calls } = setup([dnsFailure(), dnsFailure()]);
    await expect(http("https://wiki.exemplo/x")).rejects.toThrow("falha de rede: fetch failed (EAI_AGAIN)");
    expect(calls).toHaveLength(2);
  });

  it("escrita nunca é repetida aqui (a idempotência é do serviço)", async () => {
    const { http, calls } = setup([dnsFailure(), new Response("{}", { status: 202 })]);
    await expect(http("https://wiki.exemplo/v2/ativacoes", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toEqual(["POST https://wiki.exemplo/v2/ativacoes"]);
  });

  it("resposta HTTP de erro (ex.: 503) não é falha de rede e não é repetida", async () => {
    const { http, calls } = setup([new Response("{}", { status: 503 }), new Response("{}", { status: 200 })]);
    expect((await http("https://wiki.exemplo/x")).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("não loga a query string (pode ter endereço de cliente)", async () => {
    const { http, logs } = setup([new Response("{}", { status: 200 })]);
    await http("https://wiki.exemplo/v1/viabilidade?endereco=Rua%20A%2010");
    expect(logs[0]!.url).toBe("https://wiki.exemplo/v1/viabilidade?…");
  });
});
