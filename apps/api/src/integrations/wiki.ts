import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type CtoPorts, type NearbyResult, type NetworkMap } from "./types.js";

/**
 * Cliente da API versionada da SpeedWiki (/proxy/redeneutra/v1/*), só leitura.
 * Formato acordado com a Wiki: docs/CONTRATO-WIKI-V1.md. A resposta é validada; o que não
 * bate com o contrato vira erro, nunca um palpite. Mudou o formato? É só neste arquivo.
 */

const geoPoint = z.object({ lat: z.number(), lng: z.number() });

const nearbySchema = z.object({
  point: geoPoint.nullable(),
  ctos: z.array(
    z.object({
      /** null = a Wiki não resolveu a caixa (nome ambíguo). */
      ctoId: z.string().min(1).nullable(),
      name: z.string(),
      distanceM: z.number(),
      /** null = o Codemaps não informou ("avaliable" nulo). Não converter para 0. */
      freePorts: z.number().int().nonnegative().nullable(),
      usagePct: z.number().nullable(),
      location: geoPoint.nullable(),
      proximaAmbigua: z.boolean().default(false),
    }),
  ),
});

const portsSchema = z.object({
  ctoId: z.string().min(1),
  name: z.string(),
  totalPorts: z.number().int().nonnegative(),
  confidence: z.enum(["fontes_concordam", "conferir"]),
  updatedAt: z.string().datetime({ offset: true }),
  motivos: z.array(z.string()).default([]),
  ports: z.array(z.object({ port: z.number().int().positive(), state: z.enum(["livre", "ocupada", "desconhecida"]) })),
});

const healthSchema = z.object({ ok: z.boolean() });

export class WikiNetworkMap implements NetworkMap {
  private readonly root: string;

  constructor(
    private readonly http: Http,
    base: string,
    private readonly apiKey: string,
  ) {
    this.root = `${base.replace(/\/$/, "")}/proxy/redeneutra/v1`;
  }

  private request(path: string): Promise<Response> {
    return this.http(`${this.root}${path}`, { headers: { "X-RedeNeutra-Key": this.apiKey, Accept: "application/json" } });
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await this.request(path);
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new IntegrationError("wiki", `GET ${path.split("?")[0]} ${res.status}`, res.status);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  private parse<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new IntegrationError("wiki", `resposta de ${what} fora do contrato v1 (${first?.path.join(".")}: ${first?.message})`);
    }
    return parsed.data;
  }

  async findNearbyCtos(address: string, radiusM: number): Promise<NearbyResult> {
    const q = new URLSearchParams({ endereco: address, raio: String(radiusM) });
    const { body } = await this.get(`/viabilidade?${q}`);
    return this.parse(nearbySchema, body, "viabilidade");
  }

  async getCtoPorts(ctoId: string, opts: { fresh?: boolean } = {}): Promise<CtoPorts | null> {
    const query = opts.fresh ? "?fresh=true" : "";
    const { status, body } = await this.get(`/ctos/${encodeURIComponent(ctoId)}/portas${query}`);
    if (status === 404) return null;
    return this.parse(portsSchema, body, "portas");
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.request("/health");
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `chave recusada pela Wiki (${res.status})` };
      if (!res.ok) return { ok: false, detail: `Wiki respondeu ${res.status}` };
      const body = healthSchema.safeParse(await res.json().catch(() => null));
      return body.success && body.data.ok ? { ok: true, detail: "Wiki respondeu ok" } : { ok: false, detail: "resposta de saúde fora do contrato" };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "Wiki inalcançável" };
    }
  }
}
