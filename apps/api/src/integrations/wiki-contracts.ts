import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type ContractRequest, type ContractService, type ContractSnapshot } from "./types.js";
import { OperationRefused } from "./wiki-actions.js";

/**
 * Cliente de ESCRITA da SpeedWiki para criar o contrato do assinante no Voalle (POST /proxy/redeneutra/v3/contratos).
 * Formato: docs/CONTRATO-WIKI-V3-CLIENTES.md, seção H (proposta da Wiki). Chave de escrita e código do parceiro em header.
 * Só liga com CONTRACT_MODE=wiki. O corpo não leva nome de assinante nem o código do parceiro (vai só no header).
 */

const estado = z.enum(["recebida", "executando", "concluida", "parcial", "sem_confirmacao", "aguardando_equipe", "falhou"]);

const startedSchema = z.object({ operacaoId: z.string().min(1), estado: estado.default("recebida") });

const snapshotSchema = z.object({
  operacaoId: z.string().min(1),
  tipo: z.literal("contrato").optional(),
  estado,
  etapas: z.array(z.object({ nome: z.string(), estado: z.enum(["pendente", "concluida", "falhou"]), motivo: z.string().nullable().optional() })).default([]),
  resultado: z.object({ contrato: z.string().min(1), login: z.string().min(1) }).nullable().default(null),
  atualizadoEm: z.string().datetime({ offset: true }),
});

export class WikiContractService implements ContractService {
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

  async create(req: ContractRequest) {
    const { partnerCode, ...body } = req;
    const { json } = await this.call("POST", "/contratos", partnerCode, body);
    return this.parse(startedSchema, json, "contrato");
  }

  async cancel(operacaoId: string, partnerCode: string, input: { idempotencyKey: string; motivo: string }) {
    const { json } = await this.call("POST", `/contratos/${encodeURIComponent(operacaoId)}/cancelamento`, partnerCode, input);
    return this.parse(startedSchema, json, "cancelamento de contrato");
  }

  async get(operacaoId: string, partnerCode: string): Promise<ContractSnapshot | null> {
    const { status, json } = await this.call("GET", `/operacoes/${encodeURIComponent(operacaoId)}`, partnerCode);
    if (status === 404) return null;
    const s = this.parse(snapshotSchema, json, "operação de contrato");
    return { operacaoId: s.operacaoId, estado: s.estado, etapas: s.etapas, resultado: s.resultado, atualizadoEm: s.atualizadoEm };
  }
}
