/**
 * Contratos que o portal espera dos sistemas da Speed. O portal nunca expõe
 * esses sistemas ao parceiro: consome, orquestra e devolve só o recorte.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface NearbyCto {
  /**
   * Identificador estável da CTO. Pela Wiki é o id do Codemaps (string); o nome não
   * serve de chave: há nomes repetidos e caixas gêmeas. Nos clientes diretos (modo
   * real, só validação) o id é o próprio nome, e a limitação continua valendo.
   * null = o item não trouxe id (caso raro): a CTO aparece, mas não vende.
   */
  ctoId: string | null;
  name: string;
  distanceM: number;
  /** Sigla de região do nome da CTO (R1, ITA, FAT...); null se o nome não segue o padrão. */
  regiao: string | null;
  /** Vagas livres segundo o mapa (Codemaps, "avaliable"), antes de descontar reservas do portal. null = o mapa não informou. */
  freePorts: number | null;
  usagePct: number | null;
  location: GeoPoint | null;
  /** Há outra candidata a poucos metros: a CTO certa só se confirma em campo. */
  proximaAmbigua: boolean;
}

export interface NearbyResult {
  point: GeoPoint | null;
  ctos: NearbyCto[];
}

/**
 * Vagas de uma CTO: saídas de splitter livres, não portas numeradas. Qualquer saída pode ir
 * para cliente, então só a contagem importa. Base: saídas livres no diagrama do Codemaps,
 * descontando clientes que o OLTCloud tem vinculados à caixa além dos desenhados.
 */
export interface CtoVagas {
  ctoId: string;
  name: string;
  /** Sigla de região tirada do nome da CTO (R1, ITA, FAT...); null se o nome não segue o padrão. */
  regiao: string | null;
  /** Vagas livres segundo as fontes, antes de descontar as reservas do portal. */
  vagasLivres: number;
  /** Total de vagas (saídas de splitter) da CTO: base do limite de ocupação por parceiro. */
  totalVagas: number;
  /**
   * "fontes_concordam" NÃO é garantia de vaga livre: só diz que as fontes não se contradizem
   * (cliente instalado que não está desenhado nem vinculado é invisível às duas).
   * "conferir" quando o dado é fraco: não oferecer vaga.
   */
  confidence: "fontes_concordam" | "conferir";
  /** Quando a fonte leu a ocupação (ISO 8601). */
  updatedAt: string | null;
  /** Motivos para a Speed; só "conferir" bloqueia, os informativos não. */
  motivos: string[];
}

/** Mapa de rede: Codemaps (endereço → CTOs, diagrama de splitters) + OLTCloud (clientes vinculados). */
/** CTO do mapa por sigla: o mesmo formato de /vagas mais a posição (null se a Wiki não tem). */
export interface RegionCto extends CtoVagas {
  location: { lat: number; lng: number } | null;
}

export interface RegionMap {
  regiao: string;
  atualizadoEm: string;
  ctos: RegionCto[];
}

export interface NetworkMap {
  findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult>;
  /**
   * null quando a CTO não tem caixa na fonte de ocupação ou não existe (a caixa pode ter sido
   * recriada com outro id): tratar como "conferir", não como "CTO sumiu".
   * fresh = lê direto da fonte, sem snapshot; usado na reserva.
   */
  getCtoVagas(ctoId: string, opts?: { fresh?: boolean }): Promise<CtoVagas | null>;
  /** Mapa completo de uma sigla (v1.1), só CTOs com caixa no OLTCloud. null = sigla desconhecida. Ausente = integração sem essa rota. */
  getRegionCtos?(sigla: string): Promise<RegionMap | null>;
  /** A integração está de pé e a chave vale? Nunca lança. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class IntegrationError extends Error {
  constructor(
    public readonly system: string,
    message: string,
    public readonly status?: number,
  ) {
    super(`${system}: ${message}`);
  }
}

export type ActivationState =
  | "recebida"
  | "aguardando_cliente"
  | "autorizando"
  | "medindo_sinal"
  | "aguardando_decisao"
  | "provisionando"
  | "online"
  | "falha_provisionamento"
  | "cancelada"
  | "falhou";

/** Estados finais: a Wiki não muda mais, o portal para de consultar. */
export const ACTIVATION_FINAL: readonly ActivationState[] = ["online", "falha_provisionamento", "cancelada", "falhou"];

export interface PendingOnu {
  serial: string;
  modelo: string;
  /** Quando a ONU apareceu na lista de pendentes (ISO 8601). */
  vistaEm: string;
}

export interface ActivationRequest {
  idempotencyKey: string;
  ctoId: string;
  serial: string;
  contrato: string;
  pppLogin: string;
  alias: string;
  /** Código do parceiro: vai no header X-RedeNeutra-Partner (a Wiki recusa login que não termine com ele), nunca no corpo. */
  partnerCode: string;
  /** Sinal que o técnico mediu na CTO (dBm), com foto. Referência da trava. */
  sinalCtoDbm: number;
  /** Perda máxima aceita entre a CTO e a ONU (dB), vigente na hora do pedido. */
  limiteDb: number;
}

export interface ActivationSnapshot {
  ativacaoId: string;
  estado: ActivationState;
  serial: string;
  sinal: {
    ctoDbm: number;
    onuDbm: number;
    perdaDb: number;
    limiteDb: number;
    mediaOltcloudDbm: number | null;
    amostras: number | null;
  } | null;
  /** VLAN que o técnico configura na ONU. Null enquanto a Wiki não informa. */
  vlan: number | null;
  /** Em aguardando_decisao: até quando o técnico decide; depois a Wiki cancela e desautoriza. */
  prazoDecisaoAte: string | null;
  motivo: string | null;
  atualizadoEm: string;
}

export type ActivationDecision =
  | { acao: "remedir" }
  | { acao: "cancelar" }
  | { acao: "prosseguir"; justificativa: string };

/**
 * Liberação de ONU no OLTCloud, feita pela Wiki (contrato v2). É ESCRITA em produção:
 * só liga com ACTIVATION_MODE e validação do Juan. Desligada por padrão.
 */
export interface ActivationService {
  /** O código do parceiro segue em todas as chamadas (header X-RedeNeutra-Partner), como nas rotas v3. */
  listPendingOnus(ctoId: string, partnerCode: string): Promise<PendingOnu[]>;
  start(req: ActivationRequest): Promise<{ ativacaoId: string; estado: ActivationState }>;
  /** null = a Wiki não conhece essa ativação. */
  get(ativacaoId: string, partnerCode: string): Promise<ActivationSnapshot | null>;
  decide(ativacaoId: string, partnerCode: string, decision: ActivationDecision): Promise<ActivationSnapshot>;
}

export type OperationType = "bloqueio" | "desbloqueio" | "reinicio" | "cancelamento";

export type OperationState = "recebida" | "executando" | "concluida" | "parcial" | "sem_confirmacao" | "aguardando_equipe" | "falhou";

/** Estados em que a Wiki não muda mais sozinha. "parcial" e "aguardando_equipe" pedem ação (repetir ou esperar a Speed). */
export const OPERATION_FINAL: readonly OperationState[] = ["concluida", "sem_confirmacao", "falhou"];

export interface OperationStep {
  nome: string;
  estado: "pendente" | "concluida" | "falhou";
  motivo?: string | null;
}

export interface OperationRequest {
  idempotencyKey: string;
  tipo: OperationType;
  login: string;
  /** Código do parceiro: a Wiki confere que o login termina com ele (defesa contra vazamento entre parceiros). */
  partnerCode: string;
  motivo?: string | null;
}

export interface OperationSnapshot {
  operacaoId: string;
  tipo: OperationType;
  login: string;
  estado: OperationState;
  etapas: OperationStep[];
  atualizadoEm: string;
}

/**
 * Automações do cliente final, executadas pela Wiki (contrato v3). É ESCRITA em produção:
 * só liga com AUTOMATION_MODE e validação do Juan. Desligada por padrão.
 */
export interface CustomerActions {
  start(req: OperationRequest): Promise<{ operacaoId: string; estado: OperationState }>;
  /** null = a Wiki não conhece essa operação. O código do parceiro vai junto: a Wiki confere o dono da operação. */
  get(operacaoId: string, partnerCode: string): Promise<OperationSnapshot | null>;
}

// ── Criação de contrato no Voalle, pela Wiki (contrato v3, seção H) ──

export interface ContractAddress {
  cep: string;
  rua: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export interface ContractRequest {
  idempotencyKey: string;
  reservaId: string;
  parceiroCnpj: string;
  partnerCode: string;
  /** valorMensal é sempre 0: o contrato no Voalle não cobra; serve para identificar o cliente e gerar o PPPoE. */
  plano: { velocidadeMbps: number; valorMensal: 0 };
  ctoId: string;
  endereco: ContractAddress;
  location: { lat: number; lng: number } | null;
}

export interface ContractSnapshot {
  operacaoId: string;
  estado: OperationState;
  etapas: OperationStep[];
  /** Só quando concluída. */
  resultado: { contrato: string; login: string } | null;
  atualizadoEm: string;
}

/** ESCRITA em produção: cria o contrato do assinante no Voalle. Só liga com CONTRACT_MODE e validação do Juan. */
export interface ContractService {
  create(req: ContractRequest): Promise<{ operacaoId: string; estado: OperationState }>;
  /** Lê a operação de criação ou a de cancelamento (as duas pelo mesmo GET /v3/operacoes/{id}). */
  get(operacaoId: string, partnerCode: string): Promise<ContractSnapshot | null>;
  /**
   * Cancela um contrato que não virou instalação (POST /v3/contratos/{operacaoId}/cancelamento, combinado em 18 out).
   * O Voalle não tem endpoint de cancelar: a etapa contrato_cancelado vira aguardando_equipe (tarefa da Speed) e
   * conexao_removida acontece junto, porque o Voalle apaga a conexão ao cancelar.
   */
  cancel(operacaoId: string, partnerCode: string, input: { idempotencyKey: string; motivo: string }): Promise<{ operacaoId: string; estado: OperationState }>;
}

export interface TicketRequest {
  idempotencyKey: string;
  tipo: string;
  origem: "parceiro" | "sistema";
  parceiro: { codigo: string; nome: string };
  ctoId: string | null;
  login: string | null;
  descricao: string;
  sinalMedidoDbm: number | null;
  slaHoras: number;
  /** Links assinados (48 h) das fotos anexadas; a Wiki baixa na criação. */
  fotos: { tipo: string; url: string }[];
}

export type TicketRemoteState = "aberto" | "em_atendimento" | "aguardando_parceiro" | "resolvido" | "cancelado";

export interface TicketSnapshot {
  chamadoId: string;
  estado: TicketRemoteState;
  atualizadoEm: string;
  historico: { em: string; autor: "parceiro" | "infra" | "sistema"; texto: string }[];
  resolucao: string | null;
}

/**
 * Chamados de infraestrutura na Wiki (contrato v3, seção D). É ESCRITA em produção:
 * só liga com AUTOMATION_MODE e validação do Juan. Desligado por padrão.
 */
export interface TicketService {
  create(req: TicketRequest): Promise<{ chamadoId: string; estado: TicketRemoteState }>;
  get(chamadoId: string, partnerCode: string): Promise<TicketSnapshot | null>;
  addMessage(chamadoId: string, partnerCode: string, input: { idempotencyKey: string; texto: string }): Promise<void>;
}

export interface Integrations {
  network: NetworkMap;
  /** Ausente = ACTIVATION_MODE=off: as rotas de ativação respondem 503. */
  activation?: ActivationService;
  /** Ausente = AUTOMATION_MODE=off: as automações do cliente respondem 503. */
  actions?: CustomerActions;
  /** Ausente = AUTOMATION_MODE=off: o chamado fica guardado no portal ("recebido") até a integração ligar. */
  tickets?: TicketService;
  /** Ausente = CLIENT_STATUS_MODE=off: a tela do cliente mostra que o status ainda não está ligado. */
  clientStatus?: ClientStatusService;
  /** Ausente = CONTRACT_MODE=off: o contrato segue sendo informado à mão na ativação. */
  contracts?: ContractService;
}

// ── Tela do cliente: semáforo e histórico de sinal (leitura, contrato v3, seção A) ──

export type FibraEstado = "online" | "offline" | "loss" | "sem_energia" | "inativo" | "desabilitada" | "desconhecido";
export type AutenticacaoEstado = "conectado" | "desconectado" | "desconhecido";
export type ContratoEstado = "ativo" | "pendente_aprovacao" | "rejeitado" | "bloqueado" | "suspenso" | "cancelado" | "desconhecido";

export interface ClientStatus {
  login: string;
  fibra: { estado: FibraEstado; sinalDbm: number | null; uptimeDesde: string | null; ultimaQuedaEm: string | null; atualizadoEm: string | null };
  autenticacao: { estado: AutenticacaoEstado; ip: string | null; desde: string | null; atualizadoEm: string | null; motivo?: string | null };
  contrato: { estado: ContratoEstado; desde: string | null; atualizadoEm: string | null };
  onu: { serial: string; modelo: string | null; olt: string | null; vlan: number | null } | null;
}

export interface SignalSeries {
  login: string;
  dias: number;
  pontos: { em: string; rxDbm: number }[];
  quedas: { inicio: string; fim: string | null; tipo: "loss" | "sem_energia" | "offline" }[];
}

export interface ClientSummary {
  login: string;
  fibra: FibraEstado;
  autenticacao: AutenticacaoEstado;
  contrato: ContratoEstado;
  fibraEm: string | null;
  autenticacaoEm: string | null;
}

/** Leitura do estado dos clientes. Resposta de rota fora do ar vira erro (IntegrationError); login desconhecido, null. */
export interface ClientStatusService {
  status(login: string, partnerCode: string, opts?: { fresh?: boolean }): Promise<ClientStatus | null>;
  signal(login: string, partnerCode: string, dias: number): Promise<SignalSeries | null>;
  /** Até 200 logins, sempre do snapshot. */
  summary(logins: string[], partnerCode: string): Promise<ClientSummary[]>;
}
