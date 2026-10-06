/**
 * Contratos que o portal espera dos sistemas da Speed. O portal nunca expõe
 * esses sistemas ao parceiro: consome, orquestra e devolve só o recorte.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface NearbyCto {
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

export interface CtoPort {
  port: number;
  occupied: boolean;
}

export interface CtoPorts {
  name: string;
  totalPorts: number;
  ports: CtoPort[];
}

/** Mapa de rede: Codemaps (endereço → CTOs) + OLTCloud (ocupação porta a porta). */
export interface NetworkMap {
  findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult>;
  /** null quando a CTO não é encontrada na fonte de ocupação. */
  getCtoPorts(ctoName: string): Promise<CtoPorts | null>;
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
