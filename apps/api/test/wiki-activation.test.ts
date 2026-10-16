import { afterEach, describe, expect, it } from "vitest";
import type { Http } from "../src/integrations/http.js";
import { MockActivationService } from "../src/integrations/mock-activation.js";
import { MockNetworkMap } from "../src/integrations/mock.js";
import type { ActivationService } from "../src/integrations/types.js";
import { ActivationRefused, WikiActivationService } from "../src/integrations/wiki-activation.js";
import { setup } from "./helpers.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const build = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    return respond(url, init);
  };
  return { svc: new WikiActivationService(http, "https://wiki.exemplo/", "chave-escrita"), calls };
};

const REQ = {
  idempotencyKey: "3f5f7c9e-8a4c-4c52-9a1a-111111111111",
  ctoId: "24109",
  serial: "ZTEGC0000001",
  contrato: "12345",
  pppLogin: "12345-JHV",
  alias: "12345-JHV",
  partnerCode: "JHV",
  sinalCtoDbm: -20,
  limiteDb: 1.5,
};

describe("WikiActivationService (v2): código do parceiro e rotas desligadas", () => {
  it("manda X-RedeNeutra-Partner em toda chamada e não manda o código nem porta no corpo", async () => {
    const { svc, calls } = build((url) => (url.includes("pendentes") ? json({ onus: [] }) : json({ ativacaoId: "a1", estado: "recebida" }, 202)));
    await svc.listPendingOnus("24109", "JHV");
    await svc.start(REQ);
    expect(calls.map((c) => c.headers["X-RedeNeutra-Partner"])).toEqual(["JHV", "JHV"]);
    expect(calls.every((c) => c.headers["X-RedeNeutra-Write-Key"] === "chave-escrita")).toBe(true);
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({ pppLogin: "12345-JHV", alias: "12345-JHV", idempotencyKey: REQ.idempotencyKey });
    expect(body.partnerCode).toBeUndefined();
    expect(body.porta).toBeUndefined();
  });

  it("leitura e decisão também levam o código do parceiro", async () => {
    const snap = { ativacaoId: "a1", estado: "online", serial: "ZTEGC0000001", sinal: null, vlan: null, prazoDecisaoAte: null, motivo: null, atualizadoEm: "2026-10-16T10:00:00-03:00" };
    const { svc, calls } = build(() => json(snap));
    await svc.get("a1", "JHV");
    await svc.decide("a1", "JHV", { acao: "cancelar" });
    expect(calls.map((c) => `${c.method} ${c.url.split("/v2")[1]} ${c.headers["X-RedeNeutra-Partner"]}`)).toEqual(["GET /ativacoes/a1 JHV", "POST /ativacoes/a1/decisao JHV"]);
  });

  it("os três 503 de v2 desligada viram ActivationRefused; outros 503 seguem como queda da Wiki", async () => {
    for (const code of ["chave_de_escrita_nao_configurada", "ativacao_desligada", "leitura_de_sinal_pendente"]) {
      const { svc } = build(() => json({ error: code }, 503));
      await expect(svc.start(REQ)).rejects.toMatchObject({ code, status: 503 });
    }
    const { svc } = build(() => json({ error: "outra_coisa" }, 503));
    await expect(svc.start(REQ)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("wiki:") });
    await expect(svc.start(REQ)).rejects.not.toBeInstanceOf(ActivationRefused);
  });

  it("serial_em_ativacao (409) e login_fora_do_padrao (422) chegam como recusa com o código", async () => {
    await expect(build(() => json({ error: "serial_em_ativacao" }, 409)).svc.start(REQ)).rejects.toMatchObject({ code: "serial_em_ativacao", status: 409 });
    await expect(build(() => json({ error: "login_fora_do_padrao" }, 422)).svc.start(REQ)).rejects.toMatchObject({ code: "login_fora_do_padrao", status: 422 });
  });
});

describe("portal diante da Wiki com a v2 ainda desligada", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  const ADDRESS = "Rua dos Testes, 100, Belo Horizonte";
  /** Serviço que se comporta como a Wiki desligada (503 ativacao_desligada) ou recusa o pedido. */
  const stub = (error: ActivationRefused): ActivationService => ({
    listPendingOnus: async () => {
      throw error;
    },
    start: async () => {
      throw error;
    },
    get: async () => {
      throw error;
    },
    decide: async () => {
      throw error;
    },
  });

  async function ready(svc: ActivationService) {
    const ctx = await setup(new MockNetworkMap(), svc);
    close = ctx.close;
    const a = await ctx.createPartner("JHV Telecom", "11111111000111", { code: "JHV", maxCtoOccupancyPct: 100, maxActiveReservations: 50 });
    const cookie = await ctx.login(a.atendente);
    await ctx.call(cookie, "POST", "/viability", { address: ADDRESS });
    const { reservation } = await (await ctx.call(cookie, "POST", "/reservations", { ctoId: "CTO-TESTE-01", address: ADDRESS })).json();
    await ctx.setCliente(cookie, reservation.id);
    await ctx.upload(cookie, reservation.id, { kind: "medicao" });
    return { ctx, cookie, id: reservation.id as string };
  }

  it("lista de pendentes e pedido respondem 503 com aviso claro, e o pedido recusado por 503 não vira falha", async () => {
    const { ctx, cookie, id } = await ready(stub(new ActivationRefused("ativacao_desligada", 503)));
    const pend = await ctx.call(cookie, "GET", `/reservations/${id}/onus-pendentes`);
    expect(pend.status).toBe(503);
    expect((await pend.json()).error).toBe("ativacao_indisponivel");
    const start = await ctx.call(cookie, "POST", "/activations", { reservationId: id, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 });
    expect(start.status).toBe(503);
    expect((await start.json()).message).toMatch(/ainda não foi liberada/);
    // O pedido ficou guardado ("recebida"), então repetir depois de a Speed ligar não duplica nem trava a reserva.
    const list = (await (await ctx.call(cookie, "GET", "/activations")).json()).activations;
    expect(list[0].state).toBe("recebida");
  });

  it("recusas de negócio da Wiki viram texto claro e fecham a ativação", async () => {
    for (const [code, text] of [["serial_em_ativacao", /outra ativação/], ["login_fora_do_padrao", /padrão contrato-código/]] as const) {
      const { ctx, cookie, id } = await ready(stub(new ActivationRefused(code, code === "serial_em_ativacao" ? 409 : 422)));
      const res = await ctx.call(cookie, "POST", "/activations", { reservationId: id, serial: "ZTEGC0000001", contrato: "12345", sinalCtoDbm: -20 });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe(code);
      expect(body.message).toMatch(text);
      await close?.();
      close = undefined;
    }
  });

  it("o mock continua passando o código do parceiro (assinatura nova)", async () => {
    const mock = new MockActivationService();
    expect(await mock.listPendingOnus("x", "JHV")).toBeInstanceOf(Array);
  });
});
