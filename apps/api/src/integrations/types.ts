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
  /** Portas livres segundo o mapa (Codemaps), antes de descontar reservas do portal. null = o mapa não informou. */
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
 * "desconhecida" = a fonte não consegue afirmar. Nunca vale como livre:
 * ausência de marcação de ocupada não prova que a porta está livre.
 */
export type PortState = "livre" | "ocupada" | "desconhecida";

export interface CtoPort {
  port: number;
  state: PortState;
}

export interface CtoPorts {
  ctoId: string;
  name: string;
  /**
   * "fontes_concordam" NÃO é garantia de que a porta está livre: só diz que as fontes
   * não se contradizem (porta livre com ONU não vinculada ainda parece livre).
   * "conferir" quando divergem ou o dado é fraco: não oferecer porta.
   */
  confidence: "fontes_concordam" | "conferir";
  /** Quando a fonte leu a ocupação (ISO 8601). null = a fonte não informou. */
  updatedAt: string | null;
  /** Por que a CTO está em "conferir" (para a Speed, nunca para o parceiro). */
  motivos: string[];
  totalPorts: number;
  ports: CtoPort[];
}

/** Mapa de rede: Codemaps (endereço → CTOs) + OLTCloud (ocupação porta a porta). */
export interface NetworkMap {
  findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult>;
  /**
   * null quando a CTO não é encontrada na fonte de ocupação (a caixa pode ter sido
   * recriada com outro id: tratar como "conferir", não como "CTO sumiu").
   * fresh = lê direto da fonte, sem snapshot; usado na reserva.
   */
  getCtoPorts(ctoId: string, opts?: { fresh?: boolean }): Promise<CtoPorts | null>;
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

export interface Integrations {
  network: NetworkMap;
}
