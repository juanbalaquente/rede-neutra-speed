import { randomUUID } from "node:crypto";
import { IntegrationError, type TicketRemoteState, type TicketRequest, type TicketService, type TicketSnapshot } from "./types.js";

interface Entry {
  req: TicketRequest;
  estado: TicketRemoteState;
  historico: TicketSnapshot["historico"];
  resolucao: string | null;
  polls: number;
}

/**
 * Wiki de mentira para chamados. Cada leitura avança um estado: aberto, em atendimento, resolvido, com mensagem da Infra.
 * `failNext` simula a Wiki fora do ar na próxima criação (o chamado fica "recebido" no portal).
 */
export class MockTicketService implements TicketService {
  private readonly byId = new Map<string, Entry>();
  private readonly byKey = new Map<string, string>();
  readonly messages: { chamadoId: string; texto: string }[] = [];
  readonly created: TicketRequest[] = [];
  failNext = false;

  async create(req: TicketRequest) {
    if (this.failNext) {
      this.failNext = false;
      throw new IntegrationError("wiki", "POST /chamados 503", 503);
    }
    const known = this.byKey.get(req.idempotencyKey);
    if (known) return { chamadoId: known, estado: this.byId.get(known)!.estado };
    const id = randomUUID();
    this.byId.set(id, { req, estado: "aberto", historico: [], resolucao: null, polls: 0 });
    this.byKey.set(req.idempotencyKey, id);
    this.created.push(req);
    return { chamadoId: id, estado: "aberto" as const };
  }

  async get(id: string, _partnerCode: string): Promise<TicketSnapshot | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    e.polls += 1;
    const now = new Date().toISOString();
    if (e.polls === 1) {
      e.estado = "em_atendimento";
      e.historico.push({ em: now, autor: "infra", texto: "Chamado em atendimento. Técnico a caminho." });
    } else if (e.polls === 2) {
      e.estado = "resolvido";
      e.resolucao = "CTO conferida e organizada.";
      e.historico.push({ em: now, autor: "infra", texto: "CTO conferida e organizada." });
    }
    return { chamadoId: id, estado: e.estado, atualizadoEm: now, historico: e.historico.map((h) => ({ ...h })), resolucao: e.resolucao };
  }

  async addMessage(chamadoId: string, _partnerCode: string, input: { idempotencyKey: string; texto: string }) {
    this.messages.push({ chamadoId, texto: input.texto });
  }
}
