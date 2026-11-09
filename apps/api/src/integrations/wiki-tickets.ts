import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type TicketRequest, type TicketService, type TicketSnapshot } from "./types.js";

/**
 * Cliente da SpeedWiki para chamados de infraestrutura (/proxy/redeneutra/v3/chamados, contrato v3, seção D).
 * Escrita: usa X-RedeNeutra-Write-Key e o código do parceiro em X-RedeNeutra-Partner. Só liga com AUTOMATION_MODE=wiki.
 */

const estado = z.enum(["aberto", "em_atendimento", "aguardando_parceiro", "resolvido", "cancelado"]);

const createdSchema = z.object({ chamadoId: z.string().min(1), estado });

const snapshotSchema = z.object({
  chamadoId: z.string().min(1),
  estado,
  atualizadoEm: z.string().datetime({ offset: true }),
  historico: z.array(z.object({ em: z.string().datetime({ offset: true }), autor: z.enum(["parceiro", "infra", "sistema"]), texto: z.string() })).default([]),
  resolucao: z.string().nullable().default(null),
});

export class WikiTicketService implements TicketService {
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

  async create(req: TicketRequest) {
    const { json } = await this.call("POST", "/chamados", req.parceiro.codigo, req);
    return this.parse(createdSchema, json, "chamado");
  }

  async get(chamadoId: string, partnerCode: string): Promise<TicketSnapshot | null> {
    const { status, json } = await this.call("GET", `/chamados/${encodeURIComponent(chamadoId)}`, partnerCode);
    if (status === 404) return null;
    return this.parse(snapshotSchema, json, "chamado");
  }

  async addMessage(chamadoId: string, partnerCode: string, input: { idempotencyKey: string; texto: string }) {
    await this.call("POST", `/chamados/${encodeURIComponent(chamadoId)}/mensagens`, partnerCode, input);
  }
}
