import { randomUUID } from "node:crypto";
import {
  ACTIVATION_FINAL,
  type ActivationDecision,
  type ActivationRequest,
  type ActivationService,
  type ActivationSnapshot,
  type ActivationState,
  type PendingOnu,
} from "./types.js";

interface Entry {
  req: ActivationRequest;
  estado: ActivationState;
  onuDbm: number;
  prazoDecisaoAte: string | null;
  motivo: string | null;
}

/**
 * Wiki de mentira para testes e desenvolvimento. Avança um estado a cada leitura.
 * Serial terminada em "BAD" mede 3 dB de perda (reprova a trava); qualquer outra, 0,8 dB.
 */
export class MockActivationService implements ActivationService {
  private readonly byId = new Map<string, Entry>();
  private readonly byKey = new Map<string, string>();
  /** Serial → CTOs em que a ONU aparece como pendente. Vazio = aparece em qualquer CTO. */
  readonly pending: PendingOnu[] = [
    { serial: "ZTEGC0000001", modelo: "F670L", vistaEm: "2026-10-09T10:02:00-03:00" },
    { serial: "ZTEGC0000BAD", modelo: "F670L", vistaEm: "2026-10-09T10:05:00-03:00" },
  ];

  async listPendingOnus(): Promise<PendingOnu[]> {
    return this.pending.map((o) => ({ ...o }));
  }

  async start(req: ActivationRequest) {
    const known = this.byKey.get(req.idempotencyKey);
    if (known) return { ativacaoId: known, estado: this.byId.get(known)!.estado };
    if (!this.pending.some((o) => o.serial === req.serial)) {
      const err = new Error("serial_nao_pendente") as Error & { code: string };
      err.code = "serial_nao_pendente";
      throw err;
    }
    const id = randomUUID();
    const onuDbm = req.sinalCtoDbm - (req.serial.endsWith("BAD") ? 3 : 0.8);
    this.byId.set(id, { req, estado: "recebida", onuDbm, prazoDecisaoAte: null, motivo: null });
    this.byKey.set(req.idempotencyKey, id);
    return { ativacaoId: id, estado: "recebida" as const };
  }

  private snapshot(id: string, e: Entry): ActivationSnapshot {
    const medido = ["aguardando_decisao", "provisionando", "online", "falha_provisionamento"].includes(e.estado) || (e.estado === "cancelada" && e.prazoDecisaoAte !== null);
    return {
      ativacaoId: id,
      estado: e.estado,
      serial: e.req.serial,
      sinal: medido
        ? {
            ctoDbm: e.req.sinalCtoDbm,
            onuDbm: e.onuDbm,
            perdaDb: Math.round((e.req.sinalCtoDbm - e.onuDbm) * 10) / 10,
            limiteDb: e.req.limiteDb,
            mediaOltcloudDbm: e.req.sinalCtoDbm - 1,
            amostras: 7,
          }
        : null,
      prazoDecisaoAte: e.prazoDecisaoAte,
      motivo: e.motivo,
      atualizadoEm: new Date().toISOString(),
    };
  }

  async get(id: string) {
    const e = this.byId.get(id);
    if (!e) return null;
    if (!ACTIVATION_FINAL.includes(e.estado) && e.estado !== "aguardando_decisao") {
      const next: Partial<Record<ActivationState, ActivationState>> = {
        recebida: "autorizando",
        autorizando: "medindo_sinal",
        provisionando: "online",
      };
      if (e.estado === "medindo_sinal") {
        const perda = e.req.sinalCtoDbm - e.onuDbm;
        if (perda > e.req.limiteDb) {
          e.estado = "aguardando_decisao";
          e.prazoDecisaoAte = new Date(Date.now() + 30 * 60_000).toISOString();
        } else e.estado = "provisionando";
      } else e.estado = next[e.estado] ?? e.estado;
    }
    return this.snapshot(id, e);
  }

  async decide(id: string, decision: ActivationDecision) {
    const e = this.byId.get(id);
    if (!e) throw new Error("ativacao_nao_encontrada");
    if (e.estado !== "aguardando_decisao") {
      const err = new Error("estado_invalido") as Error & { code: string };
      err.code = "estado_invalido";
      throw err;
    }
    if (decision.acao === "prosseguir") e.estado = "provisionando";
    else if (decision.acao === "cancelar") {
      e.estado = "cancelada";
      e.motivo = "cancelada pelo técnico na trava de sinal";
    } else e.estado = "medindo_sinal";
    return this.snapshot(id, e);
  }
}
