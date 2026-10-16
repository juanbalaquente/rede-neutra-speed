import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type ClientStatus, type ClientStatusService, type ClientSummary, type SignalSeries } from "./types.js";

/**
 * Leitura do estado dos clientes na SpeedWiki (/proxy/redeneutra/v3/clientes, contrato v3 seção A).
 * Só leitura (X-RedeNeutra-Key). Cada fonte (OLTCloud, NE40, Voalle) responde por si: uma fora do ar vem "desconhecido".
 */

const iso = z.string().datetime({ offset: true });
const when = iso.nullable().default(null);

const fibraEstado = z.enum(["online", "offline", "loss", "sem_energia", "inativo", "desabilitada", "desconhecido"]);
const authEstado = z.enum(["conectado", "desconectado", "desconhecido"]);
const contratoEstado = z.enum(["ativo", "bloqueado", "suspenso", "cancelado", "desconhecido"]);

const statusSchema = z.object({
  login: z.string().min(1),
  fibra: z.object({
    estado: fibraEstado,
    // O sentinela -99.99 (sem leitura óptica) nunca chega como dBm: se vier, vira "sem leitura".
    sinalDbm: z.number().nullable().default(null),
    uptimeDesde: when,
    ultimaQuedaEm: when,
    atualizadoEm: when,
  }),
  autenticacao: z.object({ estado: authEstado, ip: z.string().nullable().default(null), desde: when, atualizadoEm: when }),
  contrato: z.object({ estado: contratoEstado, desde: z.string().nullable().default(null), atualizadoEm: when }),
  onu: z.object({ serial: z.string(), modelo: z.string().nullable().default(null), olt: z.string().nullable().default(null), vlan: z.number().int().nullable().default(null) }).nullable().default(null),
});

const signalSchema = z.object({
  login: z.string().min(1),
  dias: z.number().int(),
  pontos: z.array(z.object({ em: iso, rxDbm: z.number() })),
  quedas: z.array(z.object({ inicio: iso, fim: iso.nullable().default(null), tipo: z.enum(["loss", "sem_energia", "offline"]) })).default([]),
});

const summarySchema = z.object({
  clientes: z.array(z.object({ login: z.string().min(1), fibra: fibraEstado, autenticacao: authEstado, contrato: contratoEstado, fibraEm: when, autenticacaoEm: when })),
});

const SENTINEL = -99;

export class WikiClientStatus implements ClientStatusService {
  private readonly root: string;

  constructor(
    private readonly http: Http,
    base: string,
    private readonly apiKey: string,
  ) {
    this.root = `${base.replace(/\/$/, "")}/proxy/redeneutra/v3`;
  }

  private async call(method: "GET" | "POST", path: string, partnerCode: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.http(`${this.root}${path}`, {
      method,
      headers: {
        "X-RedeNeutra-Key": this.apiKey,
        "X-RedeNeutra-Partner": partnerCode,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) throw new IntegrationError("wiki", `${method} ${path.split("?")[0]} ${res.status}`, res.status);
    return { status: res.status, json };
  }

  private parse<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new IntegrationError("wiki", `resposta de ${what} fora do contrato v3 (${first?.path.join(".")}: ${first?.message})`);
    }
    return parsed.data;
  }

  async status(login: string, partnerCode: string, opts: { fresh?: boolean } = {}): Promise<ClientStatus | null> {
    const { status, json } = await this.call("GET", `/clientes/${encodeURIComponent(login)}/status${opts.fresh ? "?fresh=true" : ""}`, partnerCode);
    if (status === 404) return null;
    const s = this.parse(statusSchema, json, "status do cliente");
    if (s.fibra.sinalDbm !== null && s.fibra.sinalDbm <= SENTINEL) s.fibra.sinalDbm = null;
    return s;
  }

  async signal(login: string, partnerCode: string, dias: number): Promise<SignalSeries | null> {
    const { status, json } = await this.call("GET", `/clientes/${encodeURIComponent(login)}/sinal?dias=${dias}`, partnerCode);
    if (status === 404) return null;
    const s = this.parse(signalSchema, json, "sinal do cliente");
    return { ...s, pontos: s.pontos.filter((p) => p.rxDbm > SENTINEL) };
  }

  async summary(logins: string[], partnerCode: string): Promise<ClientSummary[]> {
    const out: ClientSummary[] = [];
    for (let i = 0; i < logins.length; i += 200) {
      const { json } = await this.call("POST", "/clientes/status", partnerCode, { logins: logins.slice(i, i + 200) });
      out.push(...this.parse(summarySchema, json, "lote de clientes").clientes);
    }
    return out;
  }
}
