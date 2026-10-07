import type { Http } from "./http.js";
import { IntegrationError, type CtoPorts } from "./types.js";

interface OcBoxPort {
  port: number;
  /** "Livre" | "Ocupada" */
  status: string;
}

interface OcBox {
  id: number;
  name: string;
  ports: number;
  occupation?: OcBoxPort[];
}

const BOX_INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cliente do OLTCloud (API REST v2, token Bearer). Mesma conta e endpoints
 * que a SpeedWiki já usa (box/list, box/{id}). Os nomes das caixas no
 * OLTCloud são sincronizados do Codemaps, por isso o nome da CTO é a ponte.
 */
export class OltcloudClient {
  private access = "";
  private accessExp = 0;
  private boxIndex: Map<string, number> | null = null;
  private boxIndexAt = 0;

  constructor(
    private readonly http: Http,
    private readonly base: string,
    private readonly user: string,
    private readonly pass: string,
  ) {}

  private async getToken(): Promise<string> {
    if (this.access && Date.now() < this.accessExp - 30_000) return this.access;
    const res = await this.http(`${this.base}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.user, password: this.pass }),
    });
    if (!res.ok) throw new IntegrationError("oltcloud", `login ${res.status}`, res.status);
    const { access } = (await res.json()) as { access: string };
    this.access = access;
    this.accessExp = jwtExpMs(access) ?? Date.now() + 5 * 60 * 1000;
    return this.access;
  }

  async get<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const call = async () => this.http(url, { headers: { Authorization: `Bearer ${await this.getToken()}` } });
    let res = await call();
    if (res.status === 401) {
      this.access = "";
      res = await call();
    }
    if (!res.ok) throw new IntegrationError("oltcloud", `GET ${path.split("?")[0]} ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  private async loadBoxIndex(): Promise<Map<string, number>> {
    if (this.boxIndex && Date.now() - this.boxIndexAt < BOX_INDEX_TTL_MS) return this.boxIndex;
    const index = new Map<string, number>();
    let next: string | null = "/api/v2/box/list";
    while (next) {
      const page: { results?: OcBox[]; next?: string | null } = await this.get(next);
      for (const box of page.results ?? []) index.set(normalizeName(box.name), box.id);
      next = page.next ?? null;
    }
    if (index.size === 0) throw new IntegrationError("oltcloud", "box/list veio vazio");
    this.boxIndex = index;
    this.boxIndexAt = Date.now();
    return index;
  }

  async getCtoPorts(ctoName: string): Promise<CtoPorts | null> {
    const index = await this.loadBoxIndex();
    const id = index.get(normalizeName(ctoName));
    if (id == null) return null;
    const { box } = await this.get<{ box: OcBox }>(`/api/v2/box/${id}`);
    const occupation = new Map((box.occupation ?? []).map((p) => [p.port, p.status]));
    // Só "Livre" explícito vale como livre; porta sem registro é "desconhecida".
    const ports = Array.from({ length: box.ports }, (_, i) => {
      const port = i + 1;
      const status = occupation.get(port);
      const state = status == null ? "desconhecida" : status === "Livre" ? "livre" : "ocupada";
      return { port, state } as const;
    });
    return { ctoId: ctoName, name: box.name, confidence: "fontes_concordam", updatedAt: new Date().toISOString(), motivos: [], totalPorts: box.ports, ports };
  }
}

function normalizeName(name: string): string {
  return name.trim().toUpperCase();
}

function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
