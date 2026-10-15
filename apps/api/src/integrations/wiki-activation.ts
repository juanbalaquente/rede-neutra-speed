import { z } from "zod";
import type { Http } from "./http.js";
import {
  IntegrationError,
  type ActivationDecision,
  type ActivationRequest,
  type ActivationService,
  type ActivationSnapshot,
  type PendingOnu,
} from "./types.js";

/**
 * Cliente de ESCRITA da SpeedWiki (/proxy/redeneutra/v2/*): liberação de ONU.
 * Formato: docs/CONTRATO-WIKI-V2-ATIVACAO.md (proposta, ainda não implementada na Wiki).
 * Usa chave própria (X-RedeNeutra-Write-Key), separada da de leitura. Só liga com ACTIVATION_MODE=wiki.
 */

const estado = z.enum([
  "recebida",
  "aguardando_cliente",
  "autorizando",
  "medindo_sinal",
  "aguardando_decisao",
  "provisionando",
  "online",
  "falha_provisionamento",
  "cancelada",
  "falhou",
]);

const snapshotSchema = z.object({
  ativacaoId: z.string().min(1),
  estado,
  serial: z.string().min(1),
  sinal: z
    .object({
      ctoDbm: z.number(),
      onuDbm: z.number(),
      perdaDb: z.number(),
      limiteDb: z.number(),
      mediaOltcloudDbm: z.number().nullable().default(null),
      amostras: z.number().int().nullable().default(null),
    })
    .nullable(),
  prazoDecisaoAte: z.string().datetime({ offset: true }).nullable().default(null),
  motivo: z.string().nullable().default(null),
  atualizadoEm: z.string().datetime({ offset: true }),
});

const pendingSchema = z.object({
  onus: z.array(z.object({ serial: z.string().min(1), modelo: z.string(), vistaEm: z.string().datetime({ offset: true }) })),
});

const startedSchema = z.object({ ativacaoId: z.string().min(1), estado });

/** Erro de negócio devolvido pela Wiki (409 serial_nao_pendente, porta_ocupada...). */
export class ActivationRefused extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`Wiki recusou a ativação: ${code}`);
  }
}

export class WikiActivationService implements ActivationService {
  private readonly root: string;

  constructor(
    private readonly http: Http,
    base: string,
    private readonly writeKey: string,
  ) {
    this.root = `${base.replace(/\/$/, "")}/proxy/redeneutra/v2`;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.http(`${this.root}${path}`, {
      method,
      headers: {
        "X-RedeNeutra-Write-Key": this.writeKey,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 404) return { status: 404, json: null };
    if (res.status === 409 || res.status === 422) {
      const code = (json as { error?: unknown } | null)?.error;
      throw new ActivationRefused(typeof code === "string" ? code : "recusada", res.status);
    }
    if (!res.ok) throw new IntegrationError("wiki", `${method} ${path.split("?")[0]} ${res.status}`, res.status);
    return { status: res.status, json };
  }

  private parse<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new IntegrationError("wiki", `resposta de ${what} fora do contrato v2 (${first?.path.join(".")}: ${first?.message})`);
    }
    return parsed.data;
  }

  async listPendingOnus(ctoId: string): Promise<PendingOnu[]> {
    const { json } = await this.call("GET", `/onus/pendentes?ctoId=${encodeURIComponent(ctoId)}`);
    return this.parse(pendingSchema, json, "onus pendentes").onus;
  }

  async start(req: ActivationRequest) {
    const { json } = await this.call("POST", "/ativacoes", req);
    return this.parse(startedSchema, json, "ativação");
  }

  async get(ativacaoId: string): Promise<ActivationSnapshot | null> {
    const { status, json } = await this.call("GET", `/ativacoes/${encodeURIComponent(ativacaoId)}`);
    if (status === 404) return null;
    return this.parse(snapshotSchema, json, "ativação");
  }

  async decide(ativacaoId: string, decision: ActivationDecision): Promise<ActivationSnapshot> {
    const { json } = await this.call("POST", `/ativacoes/${encodeURIComponent(ativacaoId)}/decisao`, decision);
    return this.parse(snapshotSchema, json, "decisão");
  }
}
