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

export function createHttp(system: string, log: ApiCallLogger, timeoutMs = 15_000) {
  return async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const started = Date.now();
    const method = init.method ?? "GET";
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      log({ system, method, url: redactUrl(url), status: res.status, durationMs: Date.now() - started, error: null });
      return res;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log({ system, method, url: redactUrl(url), status: null, durationMs: Date.now() - started, error: message });
      throw new IntegrationError(system, `falha de rede: ${message}`);
    }
  };
}

export type Http = ReturnType<typeof createHttp>;
