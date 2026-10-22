import { randomUUID } from "node:crypto";
import { IntegrationError, type ContractRequest, type ContractService, type ContractSnapshot, type OperationState, type OperationStep } from "./types.js";
import { OperationRefused } from "./wiki-actions.js";

interface Entry {
  req: ContractRequest;
  estado: OperationState;
  etapas: OperationStep[];
  contrato: string;
  /** Operação de cancelamento (não devolve contrato). */
  cancel?: boolean;
}

// cliente_no_oltcloud: no ar na Wiki desde 21 out 2026 (o cliente nasce no OLTCloud junto com o contrato).
const STEPS = ["contrato_criado", "conexao_ajustada", "endereco_gravado", "cliente_no_oltcloud"];

/**
 * Wiki de mentira para a criação de contrato. Cada leitura avança uma etapa.
 * CEP 00000000 simula parceiro sem cadastro no Voalle (422 parceiro_sem_cadastro); velocidade 1 Mbps,
 * plano sem serviço configurado (422 plano_nao_configurado). `failNext` simula a Wiki fora do ar.
 * O número do contrato é sequencial a partir de 90001, e o login `<contrato>-<CÓDIGO>` é montado como a Wiki faz.
 */
export class MockContractService implements ContractService {
  private readonly byId = new Map<string, Entry>();
  private readonly byKey = new Map<string, string>();
  private next = 90001;
  failNext = false;
  /** Próximo pedido para na 2ª etapa como "parcial"; repetir com a mesma chave continua de onde parou. */
  partialNext = false;
  /** Próximo pedido falha de vez depois de criar o contrato (sobra contrato órfão no Voalle). */
  hardFailNext = false;
  /** Próximo pedido para na 2ª etapa esperando a equipe da Speed (etapa manual). */
  manualNext = false;
  /** Próximo pedido é aceito e nunca sai de "recebida" (fila da Wiki parada, 21 out 2026). */
  stuckNext = false;
  /** Motivo que a Wiki manda enquanto um sistema de origem não responde ("sistema_externo_indisponivel: ..."). */
  outageMotivo: string | null = null;
  readonly created: ContractRequest[] = [];
  private readonly scenario = new Map<string, "partial" | "hard" | "manual" | "stuck">();

  async create(req: ContractRequest) {
    if (this.failNext) {
      this.failNext = false;
      throw new IntegrationError("wiki", "POST /contratos 503", 503);
    }
    if (req.endereco.cep === "00000000") throw new OperationRefused("parceiro_sem_cadastro", 422);
    if (req.plano.velocidadeMbps === 1) throw new OperationRefused("plano_nao_configurado", 422);
    const known = this.byKey.get(req.idempotencyKey);
    if (known) {
      const e = this.byId.get(known)!;
      // Repetir uma operação parcial continua de onde parou.
      if (e.estado === "parcial") {
        e.estado = "executando";
        for (const s of e.etapas) if (s.estado === "falhou") s.estado = "pendente";
      }
      return { operacaoId: known, estado: e.estado };
    }
    const id = randomUUID();
    if (this.partialNext) this.scenario.set(id, "partial");
    else if (this.hardFailNext) this.scenario.set(id, "hard");
    else if (this.manualNext) this.scenario.set(id, "manual");
    else if (this.stuckNext) this.scenario.set(id, "stuck");
    this.partialNext = this.hardFailNext = this.manualNext = this.stuckNext = false;
    this.byId.set(id, { req, estado: "recebida", etapas: STEPS.map((nome) => ({ nome, estado: "pendente" as const })), contrato: String(this.next++) });
    this.byKey.set(req.idempotencyKey, id);
    this.created.push(req);
    return { operacaoId: id, estado: "recebida" as const };
  }

  readonly cancels: { operacaoId: string; motivo: string }[] = [];

  /** Como a Wiki: o Voalle não tem endpoint de cancelar, então contrato_cancelado espera a equipe; conexao_removida vem junto. */
  async cancel(operacaoId: string, _partnerCode: string, input: { idempotencyKey: string; motivo: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new IntegrationError("wiki", "POST /contratos/:id/cancelamento 503", 503);
    }
    const original = this.byId.get(operacaoId);
    if (!original) throw new OperationRefused("contrato_desconhecido", 404 as never);
    const known = this.byKey.get(input.idempotencyKey);
    if (known) return { operacaoId: known, estado: this.byId.get(known)!.estado };
    const id = randomUUID();
    this.byId.set(id, { req: original.req, estado: "aguardando_equipe", etapas: [{ nome: "contrato_cancelado", estado: "pendente" }, { nome: "conexao_removida", estado: "pendente" }], contrato: original.contrato, cancel: true });
    this.byKey.set(input.idempotencyKey, id);
    this.cancels.push({ operacaoId, motivo: input.motivo });
    return { operacaoId: id, estado: "aguardando_equipe" as const };
  }

  /** Teste: a equipe da Speed cancelou no Voalle (e a conexão foi apagada junto). */
  finishCancel(id: string) {
    const e = this.byId.get(id);
    if (!e?.cancel) return;
    e.estado = "concluida";
    for (const s of e.etapas) s.estado = "concluida";
  }

  async get(id: string, _partnerCode: string): Promise<ContractSnapshot | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    if (e.cancel) return { operacaoId: id, estado: e.estado, etapas: e.etapas.map((s) => ({ ...s })), resultado: null, atualizadoEm: new Date().toISOString() };
    if (e.estado === "recebida" && this.scenario.get(id) === "stuck") {
      // A Wiki aceitou e não começou: nenhuma etapa anda.
    } else if (e.estado === "recebida") e.estado = "executando";
    else if (e.estado === "executando") {
      const next = e.etapas.find((s) => s.estado === "pendente");
      const kind = this.scenario.get(id);
      if (next && next.nome === "conexao_ajustada" && kind) {
        if (kind === "partial") {
          this.scenario.delete(id); // só na primeira vez
          next.estado = "falhou";
          next.motivo = "concentrador sem resposta";
          e.estado = "parcial";
        } else if (kind === "hard") {
          next.estado = "falhou";
          next.motivo = "Voalle recusou a conexão";
          e.estado = "falhou";
        } else {
          e.estado = "aguardando_equipe";
        }
      } else if (next) next.estado = "concluida";
      if (e.estado === "executando" && e.etapas.every((s) => s.estado === "concluida")) e.estado = "concluida";
    }
    return {
      operacaoId: id,
      estado: e.estado,
      etapas: e.etapas.map((s) => ({ ...s })),
      resultado: e.estado === "concluida" ? { contrato: e.contrato, login: `${e.contrato}-${e.req.partnerCode}` } : null,
      motivo: e.estado === "concluida" ? null : this.outageMotivo,
      atualizadoEm: new Date().toISOString(),
    };
  }
}
