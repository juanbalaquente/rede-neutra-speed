import type { Http } from "./http.js";
import { IntegrationError } from "./types.js";

/**
 * Cliente da API thirdparty do Voalle (client_credentials na porta 45700,
 * chamadas na 45715). Por enquanto só autentica e lê: criação de contrato,
 * aprovação e ponto de acesso dependem da validação do caminho crítico.
 */
export class VoalleClient {
  private access = "";
  private accessExp = 0;

  constructor(
    private readonly http: Http,
    private readonly host: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly syndata: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.access && Date.now() < this.accessExp - 30_000) return this.access;
    const res = await this.http(`${this.host}:45700/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "syngw",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        syndata: this.syndata,
      }),
    });
    if (!res.ok) throw new IntegrationError("voalle", `login ${res.status}`, res.status);
    const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
    this.access = access_token;
    this.accessExp = Date.now() + expires_in * 1000;
    return this.access;
  }

  async get<T>(path: string): Promise<T> {
    const url = `${this.host}:45715/external/integrations/thirdparty${path}`;
    const res = await this.http(url, { headers: { Authorization: `Bearer ${await this.getToken()}` } });
    if (!res.ok) throw new IntegrationError("voalle", `GET ${path.split("?")[0]} ${res.status}`, res.status);
    return (await res.json()) as T;
  }
}
