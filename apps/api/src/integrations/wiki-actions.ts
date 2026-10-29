import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type CustomerActions, type OperationRequest, type OperationSnapshot, type WifiRequest, type WifiResult } from "./types.js";

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
  /** Bloqueio e desbloqueio chegam os dois como `tipo: "bloqueio"`; quem separa é `acao` (22 out 2026). */
  acao: z.enum(["bloquear", "desbloquear"]).optional(),
  estado,
  etapas: z.array(z.object({ nome: z.string(), estado: z.enum(["pendente", "concluida", "falhou", "aguardando_equipe"]), motivo: z.string().nullable().optional() })).default([]),
  /** Motivo da operação. "sistema_externo_indisponivel: <erro>" = a Wiki segue tentando sozinha (21 out 2026). */
  motivo: z.string().nullable().default(null),
  atualizadoEm: z.string().datetime({ offset: true }),
});

const wifiSchema = z.object({ aplicado: z.literal(true), ssid: z.string().nullable().default(null), ssid5: z.string().nullable().default(null) });

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
    /** Cliente com tempo maior só para o Wi-Fi: gravar no ACS leva 8 a 10 s e a conferência soma mais ~5 s (Wiki, 26 out 2026). */
    private readonly wifiHttp: Http = http,
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

  async setWifi(req: WifiRequest): Promise<WifiResult> {
    const res = await this.wifiHttp(`${this.root}/clientes/${encodeURIComponent(req.login)}/wifi`, {
      method: "POST",
      headers: { "X-RedeNeutra-Write-Key": this.writeKey, "X-RedeNeutra-Partner": req.partnerCode, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ssid: req.ssid, senha: req.senha }),
    });
    const json: unknown = await res.json().catch(() => null);
    const code = (json as { error?: unknown } | null)?.error;
    // Recusas com código (inclui 429 limite_de_trocas, 502 falha_no_aparelho e 503 wifi_desligado). 504 e o resto são "sem confirmação".
    if ([403, 404, 409, 422, 429].includes(res.status) || ([502, 503].includes(res.status) && typeof code === "string")) {
      throw new OperationRefused(typeof code === "string" ? code : res.status === 404 ? "login_desconhecido" : "recusada", res.status);
    }
    if (!res.ok) throw new IntegrationError("wiki", `POST /clientes/{login}/wifi ${res.status}`, res.status);
    const { ssid, ssid5 } = this.parse(wifiSchema, json, "Wi-Fi");
    return { ssid, ssid5 };
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
