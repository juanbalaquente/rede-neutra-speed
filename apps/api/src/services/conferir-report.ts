import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rowsOf } from "../db/rows.js";

export interface ConferirRow {
  ctoId: string | null;
  name: string;
  /** Quantas consultas listaram a CTO como "conferir". */
  consultas: number;
  /** Em quantos endereços diferentes. */
  enderecos: number;
  parceiros: number;
  ultima: string;
  /** Códigos de motivo (viram texto na tela da Speed). */
  motivos: string[];
}

/**
 * CTOs que as consultas de viabilidade mais encontraram em "conferir", para a Speed
 * saber por onde começar a limpar o cadastro: demanda real, não o cadastro inteiro.
 * Agrega o que cada consulta já grava em viability_queries.result.
 */
export async function conferirReport(db: Db, days: number, limit = 200): Promise<ConferirRow[]> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const result = await db.execute(sql`
    SELECT
      e->>'ctoId' AS "ctoId",
      e->>'name' AS "name",
      count(DISTINCT q.id)::int AS "consultas",
      count(DISTINCT q.address)::int AS "enderecos",
      count(DISTINCT q.partner_id)::int AS "parceiros",
      max(q.created_at) AS "ultima",
      coalesce(array_agg(DISTINCT m.motivo) FILTER (WHERE m.motivo IS NOT NULL), '{}') AS "motivos"
    FROM viability_queries q
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(q.result->'ctos', '[]'::jsonb)) AS e
    LEFT JOIN LATERAL jsonb_array_elements_text(coalesce(e->'motivos', '[]'::jsonb)) AS m(motivo) ON true
    WHERE e->>'blocked' = 'conferir' AND q.created_at >= ${since.toISOString()}::timestamptz
    GROUP BY e->>'ctoId', e->>'name'
    ORDER BY "consultas" DESC, "ultima" DESC
    LIMIT ${limit}
  `);
  const rows = rowsOf(result);
  return rows.map((r) => ({
    ctoId: (r.ctoId as string | null) ?? null,
    name: String(r.name),
    consultas: Number(r.consultas),
    enderecos: Number(r.enderecos),
    parceiros: Number(r.parceiros),
    ultima: new Date(r.ultima as string | Date).toISOString(),
    motivos: (r.motivos as string[] | string | null) ? (Array.isArray(r.motivos) ? r.motivos : String(r.motivos).replace(/[{}"]/g, "").split(",").filter(Boolean)) : [],
  }));
}

/** CSV para cruzar com a lista da Wiki. Células que começam com = + - @ ganham um apóstrofo (injeção em planilha). */
export function conferirCsv(rows: ConferirRow[]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["id_codemaps", "nome", "consultas", "enderecos", "parceiros", "ultima_consulta", "motivos"];
  const lines = rows.map((r) => [r.ctoId, r.name, r.consultas, r.enderecos, r.parceiros, r.ultima, r.motivos.join(" | ")].map(cell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
