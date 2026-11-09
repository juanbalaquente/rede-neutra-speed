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
      // Antes da leitura da ONU (aguardando_cliente, autorizando) a Wiki manda null nos dois.
      onuDbm: z.number().nullable().default(null),
      perdaDb: z.number().nullable().default(null),
      limiteDb: z.number(),
      mediaOltcloudDbm: z.number().nullable().default(null),
      amostras: z.number().int().nullable().default(null),
    })
    .nullable(),
  vlan: z.number().int().positive().nullable().default(null),
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

  private async call(method: "GET" | "POST", path: string, partnerCode: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.http(`${this.root}${path}`, {
      method,
      headers: {
        "X-RedeNeutra-Write-Key": this.writeKey,
        "X-RedeNeutra-Partner": partnerCode,
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
    // A Wiki construiu a v2 desligada: 503 com estes códigos é "ainda não liberado", não queda da rede.
    if (res.status === 503) {
      const code = (json as { error?: unknown } | null)?.error;
      if (code === "chave_de_escrita_nao_configurada" || code === "ativacao_desligada" || code === "leitura_de_sinal_pendente") throw new ActivationRefused(code, 503);
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

  async listPendingOnus(ctoId: string, partnerCode: string): Promise<PendingOnu[]> {
    const { json } = await this.call("GET", `/onus/pendentes?ctoId=${encodeURIComponent(ctoId)}`, partnerCode);
    return this.parse(pendingSchema, json, "onus pendentes").onus;
  }

  async start(req: ActivationRequest) {
    // `porta` não existe mais (a Wiki a aceita e ignora); o código do parceiro vai só no header.
    const { partnerCode, ...body } = req;
    const { json } = await this.call("POST", "/ativacoes", partnerCode, body);
    return this.parse(startedSchema, json, "ativação");
  }

  async get(ativacaoId: string, partnerCode: string): Promise<ActivationSnapshot | null> {
    const { status, json } = await this.call("GET", `/ativacoes/${encodeURIComponent(ativacaoId)}`, partnerCode);
    if (status === 404) return null;
    return this.parse(snapshotSchema, json, "ativação");
  }

  async decide(ativacaoId: string, partnerCode: string, decision: ActivationDecision): Promise<ActivationSnapshot> {
    const { json } = await this.call("POST", `/ativacoes/${encodeURIComponent(ativacaoId)}/decisao`, partnerCode, decision);
    return this.parse(snapshotSchema, json, "decisão");
  }
}
