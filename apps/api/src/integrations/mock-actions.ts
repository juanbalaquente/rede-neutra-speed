import { randomUUID } from "node:crypto";
import type { CustomerActions, OperationRequest, OperationSnapshot, OperationState, OperationStep } from "./types.js";

interface Entry {
  req: OperationRequest;
  estado: OperationState;
  etapas: OperationStep[];
  /** Já falhou uma vez de propósito (cenário -ERR): na repetição com a mesma chave, continua. */
  failedOnce: boolean;
}

const CANCEL_STEPS = ["contrato_encerrado", "onu_removida", "porta_devolvida"];

/**
 * Wiki de mentira para testes e desenvolvimento. Avança um passo a cada leitura.
 * Códigos de parceiro especiais criam cenários: ...-ERR faz o cancelamento falhar na ONU na primeira vez
 * (fica "parcial" e a repetição continua de onde parou); ...-SEMACK faz o reinício terminar sem confirmação.
 */
export class MockCustomerActions implements CustomerActions {
  /** Motivo que a Wiki manda enquanto um sistema de origem não responde ("sistema_externo_indisponivel: ..."). */
  outageMotivo: string | null = null;
  private readonly byId = new Map<string, Entry>();
  private readonly byKey = new Map<string, string>();

  async start(req: OperationRequest) {
    const known = this.byKey.get(req.idempotencyKey);
    if (known) {
      const e = this.byId.get(known)!;
      // Repetir uma operação parcial continua de onde parou.
      if (e.estado === "parcial") e.estado = "executando";
      return { operacaoId: known, estado: e.estado };
    }
    const id = randomUUID();
    this.byId.set(id, {
      req,
      estado: "recebida",
      etapas: req.tipo === "cancelamento" ? CANCEL_STEPS.map((nome) => ({ nome, estado: "pendente" as const })) : [],
      failedOnce: false,
    });
    this.byKey.set(req.idempotencyKey, id);
    return { operacaoId: id, estado: "recebida" as const };
  }

  async get(id: string, _partnerCode: string): Promise<OperationSnapshot | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    if (e.estado === "recebida") e.estado = "executando";
    else if (e.estado === "executando") this.step(e);
    return { operacaoId: id, tipo: e.req.tipo, login: e.req.login, estado: e.estado, etapas: e.etapas.map((s) => ({ ...s })), motivo: e.estado === "concluida" ? null : this.outageMotivo, atualizadoEm: new Date().toISOString() };
  }

  private step(e: Entry) {
    if (e.req.tipo !== "cancelamento") {
      e.estado = e.req.tipo === "reinicio" && e.req.login.endsWith("-SEMACK") ? "sem_confirmacao" : "concluida";
      return;
    }
    const next = e.etapas.find((s) => s.estado !== "concluida");
    if (!next) {
      e.estado = "concluida";
      return;
    }
    if (next.nome === "onu_removida" && e.req.login.endsWith("-ERR") && !e.failedOnce) {
      e.failedOnce = true;
      next.estado = "falhou";
      next.motivo = "OLT sem resposta";
      e.estado = "parcial";
      return;
    }
    next.estado = "concluida";
    next.motivo = null;
    if (e.etapas.every((s) => s.estado === "concluida")) e.estado = "concluida";
  }
}
