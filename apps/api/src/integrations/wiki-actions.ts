import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type CustomerActions, type OperationRequest, type OperationSnapshot } from "./types.js";

/**
 * Cliente de ESCRITA da SpeedWiki para as automações do cliente final (/proxy/redeneutra/v3/*).
 * Formato: docs/CONTRATO-WIKI-V3-CLIENTES.md (proposta, ainda não implementada na Wiki).
 * Usa a chave de escrita (X-RedeNeutra-Write-Key) e o código do parceiro em X-RedeNeutra-Partner.
 * Só liga com AUTOMATION_MODE=wiki.
 */

const estado = z.enum(["recebida", "executando", "concluida", "parcial", "sem_confirmacao", "aguardando_equipe", "falhou"]);
const tipo = z.enum(["bloqueio", "desbloqueio", "reinicio", "cancelamento"]);

const snapshotSchema = z.object({
  operacaoId: z.string().min(1),
  tipo,
  login: z.string().min(1),
  estado,
  etapas: z.array(z.object({ nome: z.string(), estado: z.enum(["pendente", "concluida", "falhou"]), motivo: z.string().nullable().optional() })).default([]),
  atualizadoEm: z.string().datetime({ offset: true }),
});

const startedSchema = z.object({ operacaoId: z.string().min(1), estado });

/** Erro de negócio devolvido pela Wiki (409/422: login_de_outro_parceiro, fatura_em_aberto...). */
export class OperationRefused extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`Wiki recusou a operação: ${code}`);
  }
}

export class WikiCustomerActions implements CustomerActions {
  private readonly root: string;

  constructor(
    private readonly http: Http,
    base: string,
    private readonly writeKey: string,
  ) {
    this.root = `${base.replace(/\/$/, "")}/proxy/redeneutra/v3`;
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
    if (res.status === 403 || res.status === 409 || res.status === 422) {
      const code = (json as { error?: unknown } | null)?.error;
      throw new OperationRefused(typeof code === "string" ? code : "recusada", res.status);
    }
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

  async start(req: OperationRequest) {
    const login = encodeURIComponent(req.login);
    const [path, body] =
      req.tipo === "bloqueio" || req.tipo === "desbloqueio"
        ? [`/clientes/${login}/bloqueio`, { idempotencyKey: req.idempotencyKey, acao: req.tipo === "bloqueio" ? "bloquear" : "desbloquear", motivo: req.motivo ?? null }]
        : req.tipo === "reinicio"
          ? [`/clientes/${login}/reinicio`, { idempotencyKey: req.idempotencyKey }]
          : [`/clientes/${login}/cancelamento`, { idempotencyKey: req.idempotencyKey, motivo: req.motivo ?? null }];
    const { json } = await this.call("POST", path, req.partnerCode, body);
    return this.parse(startedSchema, json, "operação");
  }

  async get(operacaoId: string, partnerCode: string): Promise<OperationSnapshot | null> {
    const { status, json } = await this.call("GET", `/operacoes/${encodeURIComponent(operacaoId)}`, partnerCode);
    if (status === 404) return null;
    return this.parse(snapshotSchema, json, "operação");
  }
}
