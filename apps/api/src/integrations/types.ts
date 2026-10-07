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
   * Identificador estável da CTO (id da caixa). O nome não serve de chave: há
   * nomes repetidos e caixas gêmeas. Nos clientes diretos antigos (Codemaps e
   * OLTCloud sem a Wiki) o id é o próprio nome, e a limitação continua valendo.
   */
  ctoId: string;
  name: string;
  distanceM: number;
  /** Portas livres segundo o mapa (Codemaps), antes de descontar reservas do portal. */
  freePorts: number;
  usagePct: number | null;
  location: GeoPoint | null;
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
  /** "conferir" quando as fontes divergem ou o dado é fraco: não oferecer porta. */
  confidence: "confirmada" | "conferir";
  totalPorts: number;
  ports: CtoPort[];
}

/** Mapa de rede: Codemaps (endereço → CTOs) + OLTCloud (ocupação porta a porta). */
export interface NetworkMap {
  findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult>;
  /** null quando a CTO não é encontrada na fonte de ocupação. */
  getCtoPorts(ctoId: string): Promise<CtoPorts | null>;
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
