import type { CtoPort, CtoPorts, NearbyResult, NetworkMap } from "./types.js";

interface MockCto {
  /** Id da caixa; quando falta, o nome faz o papel de id. */
  id?: string;
  name: string;
  lat: number;
  lng: number;
  totalPorts: number;
  occupied: number[];
}

/** Rede de exemplo para desenvolvimento e testes. Nenhum dado real. */
export const MOCK_CTOS: MockCto[] = [
  { name: "CTO-TESTE-01", lat: -19.9191, lng: -43.9386, totalPorts: 16, occupied: [1, 2, 3, 5, 8] },
  { name: "CTO-TESTE-02", lat: -19.9195, lng: -43.9392, totalPorts: 8, occupied: [1, 2, 3, 4, 5, 6, 7, 8] },
  { name: "CTO-TESTE-03", lat: -19.9201, lng: -43.9379, totalPorts: 8, occupied: [] },
];

/** Endereços que começam com "sem viabilidade" não acham CTO nenhuma. */
export class MockNetworkMap implements NetworkMap {
  constructor(private readonly ctos: MockCto[] = MOCK_CTOS) {}

  async findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult> {
    if (/^sem viabilidade/i.test(address.trim())) return { point: { lat: -20.5, lng: -44.5 }, ctos: [] };
    const point = { lat: -19.9193, lng: -43.9385 };
    const ctos = this.ctos
      .map((c) => ({
        ctoId: c.id ?? c.name,
        name: c.name,
        distanceM: Math.round(haversineM(point.lat, point.lng, c.lat, c.lng)),
        freePorts: c.totalPorts - c.occupied.length,
        usagePct: Math.round((c.occupied.length / c.totalPorts) * 100),
        location: { lat: c.lat, lng: c.lng },
      }))
      .filter((c) => c.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);
    return { point, ctos };
  }

  async getCtoPorts(ctoId: string): Promise<CtoPorts | null> {
    const cto = this.ctos.find((c) => (c.id ?? c.name) === ctoId);
    if (!cto) return null;
    return {
      ctoId,
      name: cto.name,
      confidence: "confirmada",
      totalPorts: cto.totalPorts,
      ports: Array.from({ length: cto.totalPorts }, (_, i): CtoPort => ({
        port: i + 1,
        state: cto.occupied.includes(i + 1) ? "ocupada" : "livre",
      })),
    };
  }
}

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
