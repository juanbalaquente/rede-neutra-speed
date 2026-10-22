import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type ClientStatus, type ClientStatusService, type ClientSummary, type OnuDetail, type SignalSeries } from "./types.js";

/**
 * Leitura do estado dos clientes na SpeedWiki (/proxy/redeneutra/v3/clientes, contrato v3 seção A).
 * Só leitura (X-RedeNeutra-Key). Cada fonte (OLTCloud, NE40, Voalle) responde por si: uma fora do ar vem "desconhecido".
 */

const iso = z.string().datetime({ offset: true });
const when = iso.nullable().default(null);

/**
 * Estado que o portal ainda não conhece (a Wiki criou um novo) vira "desconhecido", com aviso no log, em vez de derrubar a tela
 * inteira: o contrato v3 pede que cada fonte responda por si e que uma leitura estranha não quebre as outras.
 */
const tolerant = <T extends string>(known: readonly T[], what: string) =>
  z.string().transform((v): T | "desconhecido" => {
    if ((known as readonly string[]).includes(v)) return v as T;
    console.warn(`[status] estado de ${what} desconhecido para o portal: "${v}"`);
    return "desconhecido";
  });

const fibraEstado = tolerant(["online", "offline", "loss", "sem_energia", "inativo", "desabilitada", "desconhecido"] as const, "fibra");
const authEstado = tolerant(["conectado", "desconectado", "desconhecido"] as const, "autenticação");
const contratoEstado = tolerant(["ativo", "pendente_aprovacao", "rejeitado", "bloqueado", "suspenso", "cancelado", "desconhecido"] as const, "contrato");

/** Ausente (Wiki anterior ao bloqueio pela ONU) vale "sem bloqueio". */
const bloqueio = z
  .object({ ativo: z.boolean(), desde: when, motivo: z.string().nullable().default(null) })
  .default({ ativo: false, desde: null, motivo: null });

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
  autenticacao: z.object({ estado: authEstado, ip: z.string().nullable().default(null), desde: when, atualizadoEm: when, motivo: z.string().nullable().default(null) }),
  contrato: z.object({ estado: contratoEstado, desde: z.string().nullable().default(null), atualizadoEm: when }),
  onu: z.object({ serial: z.string(), modelo: z.string().nullable().default(null), olt: z.string().nullable().default(null), vlan: z.number().int().nullable().default(null) }).nullable().default(null),
  bloqueio,
});

const signalSchema = z.object({
  login: z.string().min(1),
  dias: z.number().int(),
  pontos: z.array(z.object({ em: iso, rxDbm: z.number() })),
  quedas: z.array(z.object({ inicio: iso, fim: iso.nullable().default(null), tipo: z.enum(["loss", "sem_energia", "offline"]) })).default([]),
});

const summarySchema = z.object({
  clientes: z.array(
    z.object({ login: z.string().min(1), fibra: fibraEstado, autenticacao: authEstado, contrato: contratoEstado, fibraEm: when, autenticacaoEm: when, bloqueio, sinalDbm: z.number().nullable().default(null) }),
  ),
});

const num = z.number().nullable().default(null);
const int = z.number().int().nullable().default(null);
const text = z.string().nullable().default(null);

const onuSchema = z.object({
  login: z.string().min(1),
  lidoEm: when,
  onu: z.object({
    serial: z.string(),
    modelo: text,
    estado: fibraEstado,
    olt: text,
    slot: int,
    pon: int,
    rxDbm: num,
    txDbm: num,
    rxOltDbm: num,
    temperaturaC: num,
    distanciaM: num,
    ligadaDesde: when,
    ultimaQuedaEm: when,
    sinalLidoEm: when,
  }),
  pon: z.object({ onus: z.number().int(), offline: z.number().int(), mediaRxDbm: num }).nullable().default(null),
  wifi: z
    .object({
      online: z.boolean(),
      lidoEm: when,
      dispositivos: z.array(z.object({ nome: text, mac: z.string(), banda: text, ssid: text, rssiDbm: num, online: z.boolean().default(true) })).default([]),
    })
    .nullable()
    .default(null),
});

/** Sentinela -99.99 (sem leitura óptica) nunca vira dBm. */
const dbm = (n: number | null) => (n !== null && n <= SENTINEL ? null : n);

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
      out.push(...this.parse(summarySchema, json, "lote de clientes").clientes.map((c) => ({ ...c, sinalDbm: dbm(c.sinalDbm) })));
    }
    return out;
  }

  async onu(login: string, partnerCode: string): Promise<OnuDetail | null> {
    const path = `/clientes/${encodeURIComponent(login)}/onu`;
    const res = await this.http(`${this.root}${path}`, {
      headers: { "X-RedeNeutra-Key": this.apiKey, "X-RedeNeutra-Partner": partnerCode, Accept: "application/json" },
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 404) {
      // Só o 404 com corpo do contrato é login desconhecido; o 404 do roteador da Wiki é rota que ainda não existe.
      if ((json as { error?: unknown } | null)?.error === "login_desconhecido") return null;
      throw new IntegrationError("wiki", `GET ${path} 404 (rota ainda não publicada)`, 404);
    }
    if (!res.ok) throw new IntegrationError("wiki", `GET ${path} ${res.status}`, res.status);
    const d = this.parse(onuSchema, json, "diagnóstico da ONU");
    return {
      ...d,
      onu: { ...d.onu, rxDbm: dbm(d.onu.rxDbm), txDbm: d.onu.txDbm, rxOltDbm: dbm(d.onu.rxOltDbm) },
      pon: d.pon && { ...d.pon, mediaRxDbm: dbm(d.pon.mediaRxDbm) },
    };
  }
}
