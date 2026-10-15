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
export interface NetworkMap {
  findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult>;
  /**
   * null quando a CTO não tem caixa na fonte de ocupação ou não existe (a caixa pode ter sido
   * recriada com outro id): tratar como "conferir", não como "CTO sumiu".
   * fresh = lê direto da fonte, sem snapshot; usado na reserva.
   */
  getCtoVagas(ctoId: string, opts?: { fresh?: boolean }): Promise<CtoVagas | null>;
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
  listPendingOnus(ctoId: string): Promise<PendingOnu[]>;
  start(req: ActivationRequest): Promise<{ ativacaoId: string; estado: ActivationState }>;
  /** null = a Wiki não conhece essa ativação. */
  get(ativacaoId: string): Promise<ActivationSnapshot | null>;
  decide(ativacaoId: string, decision: ActivationDecision): Promise<ActivationSnapshot>;
}

export interface Integrations {
  network: NetworkMap;
  /** Ausente = ACTIVATION_MODE=off: as rotas de ativação respondem 503. */
  activation?: ActivationService;
}
