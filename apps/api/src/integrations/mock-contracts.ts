import { randomUUID } from "node:crypto";
import { IntegrationError, type ContractRequest, type ContractService, type ContractSnapshot, type OperationState, type OperationStep } from "./types.js";
import { OperationRefused } from "./wiki-actions.js";

interface Entry {
  req: ContractRequest;
  estado: OperationState;
  etapas: OperationStep[];
  contrato: string;
}

const STEPS = ["contrato_criado", "conexao_ajustada", "endereco_gravado"];

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
  readonly created: ContractRequest[] = [];

  async create(req: ContractRequest) {
    if (this.failNext) {
      this.failNext = false;
      throw new IntegrationError("wiki", "POST /contratos 503", 503);
    }
    if (req.endereco.cep === "00000000") throw new OperationRefused("parceiro_sem_cadastro", 422);
    if (req.plano.velocidadeMbps === 1) throw new OperationRefused("plano_nao_configurado", 422);
    const known = this.byKey.get(req.idempotencyKey);
    if (known) return { operacaoId: known, estado: this.byId.get(known)!.estado };
    const id = randomUUID();
    this.byId.set(id, { req, estado: "recebida", etapas: STEPS.map((nome) => ({ nome, estado: "pendente" as const })), contrato: String(this.next++) });
    this.byKey.set(req.idempotencyKey, id);
    this.created.push(req);
    return { operacaoId: id, estado: "recebida" as const };
  }

  async get(id: string, _partnerCode: string): Promise<ContractSnapshot | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    if (e.estado === "recebida") e.estado = "executando";
    else if (e.estado === "executando") {
      const next = e.etapas.find((s) => s.estado === "pendente");
      if (next) next.estado = "concluida";
      if (e.etapas.every((s) => s.estado === "concluida")) e.estado = "concluida";
    }
    return {
      operacaoId: id,
      estado: e.estado,
      etapas: e.etapas.map((s) => ({ ...s })),
      resultado: e.estado === "concluida" ? { contrato: e.contrato, login: `${e.contrato}-${e.req.partnerCode}` } : null,
      atualizadoEm: new Date().toISOString(),
    };
  }
}
