import type { Http } from "./http.js";
import { IntegrationError, type NearbyResult } from "./types.js";

const BASE = "https://speednet.codemaps.com.br/geo2";

interface CodemapsNearbyItem {
  name: string;
  distance: number;
  /** Grafia do próprio Codemaps ("avaliable"). */
  avaliable: number | null;
  usage: number | null;
  geometry?: { coordinates?: [number, number] };
}

/**
 * Cliente do Codemaps. Mesmo login e consulta que a SpeedWiki já usa em
 * /viabilidade. O Codemaps libera acesso por IP: só funciona a partir de um
 * servidor autorizado (hoje o da SpeedWiki).
 */
export class CodemapsClient {
  private validator = "";
  private validatorExp = 0;

  constructor(
    private readonly http: Http,
    private readonly token: string,
    private readonly secret: string,
  ) {}

  private async getValidator(): Promise<string> {
    if (this.validator && Date.now() < this.validatorExp) return this.validator;
    const res = await this.http(`${BASE}/login/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, secret: this.secret }),
    });
    if (!res.ok) throw new IntegrationError("codemaps", `login ${res.status}`, res.status);
    const data = (await res.json()) as { token: string };
    this.validator = data.token;
    this.validatorExp = Date.now() + 50 * 60 * 1000;
    return this.validator;
  }

  async findNearby(address: string, radiusM: number): Promise<NearbyResult> {
    const call = async () =>
      this.http(`${BASE}/equipment/nearbyaddress`, {
        method: "POST",
        headers: { "Content-Type": "application/json", validator: await this.getValidator() },
        body: JSON.stringify({ address, distance: radiusM }),
      });
    let res = await call();
    if (res.status === 401) {
      this.validator = "";
      res = await call();
    }
    if (!res.ok) throw new IntegrationError("codemaps", `nearbyaddress ${res.status}`, res.status);
    const data = (await res.json()) as {
      point?: { coordinates?: [number, number] };
      list?: CodemapsNearbyItem[];
    };
    const coords = data.point?.coordinates;
    return {
      point: coords ? { lng: coords[0], lat: coords[1] } : null,
      ctos: (data.list ?? []).map((item) => {
        const g = item.geometry?.coordinates;
        return {
          // Sem id estável vindo do Codemaps neste cliente: o nome é a chave (limitação conhecida).
          ctoId: item.name,
          name: item.name,
          distanceM: Math.round(item.distance),
          // Nulo do mapa fica nulo: converter para 0 esconderia o "não sei".
          freePorts: item.avaliable ?? null,
          usagePct: item.usage ?? null,
          location: g ? { lng: g[0], lat: g[1] } : null,
          proximaAmbigua: false,
        };
      }),
    };
  }
}
