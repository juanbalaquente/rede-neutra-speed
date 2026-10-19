import { IntegrationError } from "./types.js";

export interface ApiCallRecord {
  system: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  error: string | null;
}

export type ApiCallLogger = (record: ApiCallRecord) => void;

/** Remove query string (pode carregar dado de cliente) antes de logar. */
function redactUrl(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : `${url.slice(0, i)}?…`;
}

/**
 * "fetch failed" sozinho não diz nada: a causa real (DNS, conexão recusada, tempo esgotado) vem em `cause`.
 * Ex.: "fetch failed (EAI_AGAIN)". Foi assim que se achou o DNS do servidor travando por 5 s (19 out 2026).
 */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail && !e.message.includes(detail) ? `${e.message} (${detail})` : e.message;
}

/** Pausa antes de repetir uma leitura que falhou na rede. */
const RETRY_DELAY_MS = 300;

/**
 * Cliente HTTP das integrações: tempo máximo por chamada, log de toda chamada e UMA repetição para leituras (GET)
 * que falham na rede antes de haver resposta. Escrita nunca é repetida aqui: ela já tem idempotência própria
 * (idempotencyKey) e quem decide repetir é o serviço.
 */
export function createHttp(system: string, log: ApiCallLogger, timeoutMs = 15_000, opts: { retryDelayMs?: number } = {}) {
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS;
  async function once(url: string, init: RequestInit, method: string): Promise<Response> {
    const started = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      log({ system, method, url: redactUrl(url), status: res.status, durationMs: Date.now() - started, error: null });
      return res;
    } catch (e) {
      const message = describe(e);
      log({ system, method, url: redactUrl(url), status: null, durationMs: Date.now() - started, error: message });
      throw new IntegrationError(system, `falha de rede: ${message}`);
    }
  }
  return async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    try {
      return await once(url, init, method);
    } catch (e) {
      // Só leitura, só falha de rede (sem resposta HTTP): uma nova tentativa costuma passar quando o DNS ou a rede piscam.
      if (method !== "GET" || !(e instanceof IntegrationError)) throw e;
      await new Promise((r) => setTimeout(r, retryDelay));
      return once(url, init, method);
    }
  };
}

export type Http = ReturnType<typeof createHttp>;
