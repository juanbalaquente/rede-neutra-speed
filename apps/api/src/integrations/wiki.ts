import { z } from "zod";
import type { Http } from "./http.js";
import { IntegrationError, type CtoPorts, type NearbyResult, type NetworkMap } from "./types.js";

/**
 * Cliente da API versionada da SpeedWiki (/proxy/redeneutra/v1/*), só leitura.
 * Formato esperado: docs/CONTRATO-WIKI-V1.md. As rotas e os campos abaixo são a
 * PROPOSTA do portal e ainda não existem na Wiki: se a Wiki responder diferente,
 * o ajuste é só neste arquivo. A resposta é validada; o que não bate com o
 * contrato vira erro, nunca um palpite.
 */

const geoPoint = z.object({ lat: z.number(), lng: z.number() });

const nearbySchema = z.object({
  point: geoPoint.nullable(),
  ctos: z.array(
    z.object({
      ctoId: z.string().min(1),
      name: z.string(),
      distanceM: z.number(),
      freePorts: z.number().int().nonnegative(),
      usagePct: z.number().nullable(),
      location: geoPoint.nullable(),
    }),
  ),
});

const portsSchema = z.object({
  ctoId: z.string().min(1),
  name: z.string(),
  totalPorts: z.number().int().nonnegative(),
  confidence: z.enum(["confirmada", "conferir"]),
  ports: z.array(z.object({ port: z.number().int().positive(), state: z.enum(["livre", "ocupada", "desconhecida"]) })),
});

export class WikiNetworkMap implements NetworkMap {
  private readonly root: string;

  constructor(
    private readonly http: Http,
    base: string,
    private readonly apiKey: string,
  ) {
    this.root = `${base.replace(/\/$/, "")}/proxy/redeneutra/v1`;
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await this.http(`${this.root}${path}`, { headers: { "X-RedeNeutra-Key": this.apiKey, Accept: "application/json" } });
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

  async getCtoPorts(ctoId: string): Promise<CtoPorts | null> {
    const { status, body } = await this.get(`/ctos/${encodeURIComponent(ctoId)}/portas`);
    if (status === 404) return null;
    return this.parse(portsSchema, body, "portas");
  }
}
