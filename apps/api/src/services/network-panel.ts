import { count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rowsOf } from "../db/rows.js";
import { portReservations } from "../db/schema.js";

export type CtoEstado = "com_vaga" | "sem_vaga" | "conferir";

export interface PanelCto {
  ctoId: string;
  name: string;
  regiao: string | null;
  estado: CtoEstado;
  /** Vagas livres na última leitura (antes do limite de cada parceiro); null em consultas antigas. */
  livres: number | null;
  totalVagas: number | null;
  reservasAbertas: number;
  vistoEm: string;
}

export interface PanelRegion {
  regiao: string | null;
  ctos: PanelCto[];
  comVaga: number;
  semVaga: number;
  conferir: number;
  vagasLivres: number;
  reservasAbertas: number;
}

export interface PanelDay {
  dia: string;
  viavel: number;
  semViabilidade: number;
  foraDaArea: number;
}

export interface NetworkPanel {
  days: number;
  totals: { consultas: number; viaveis: number; foraDaArea: number; reservasAbertas: number; ctosVistas: number; ctosConferir: number };
  porDia: PanelDay[];
  regioes: PanelRegion[];
}

const TZ = "America/Sao_Paulo";

function isoDay(d: Date): string {
  // Dia civil em Brasília, no mesmo formato do to_char do banco.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Painel da Speed a partir do que o portal já registra. Não é a rede inteira: só as CTOs
 * que apareceram em alguma consulta do período, no último estado lido. O mapa completo
 * por sigla depende de uma rota da Wiki (proposta no contrato).
 */
export async function networkPanel(db: Db, days: number, now = new Date()): Promise<NetworkPanel> {
  const since = new Date(now.getTime() - days * 24 * 3600_000);

  const latest = rowsOf(
    await db.execute(sql`
      SELECT DISTINCT ON (e->>'ctoId')
        e->>'ctoId' AS "ctoId", e->>'name' AS "name", e->>'regiao' AS "regiao", e->>'blocked' AS "blocked",
        (e->>'vagas')::int AS "vagas", (e->>'livres')::int AS "livres", (e->>'totalVagas')::int AS "totalVagas",
        q.created_at AS "seen"
      FROM viability_queries q
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(q.result->'ctos', '[]'::jsonb)) AS e
      WHERE q.created_at >= ${since.toISOString()}::timestamptz AND e->>'ctoId' IS NOT NULL
      ORDER BY e->>'ctoId', q.created_at DESC
    `),
  );

  const daily = rowsOf(
    await db.execute(sql`
      SELECT to_char(q.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS "dia",
        count(*) FILTER (WHERE q.viable)::int AS "viavel",
        count(*) FILTER (WHERE NOT q.viable AND q.reason = 'fora_da_area')::int AS "foraDaArea",
        count(*) FILTER (WHERE NOT q.viable AND q.reason IS DISTINCT FROM 'fora_da_area')::int AS "semViabilidade"
      FROM viability_queries q
      WHERE q.created_at >= ${since.toISOString()}::timestamptz AND q.partner_id IS NOT NULL
      GROUP BY 1
    `),
  );

  const open = await db
    .select({ ctoId: portReservations.ctoId, n: count() })
    .from(portReservations)
    .where(eq(portReservations.status, "ativa"))
    .groupBy(portReservations.ctoId);
  const openBy = new Map(open.map((r) => [r.ctoId, Number(r.n)]));

  const ctos: PanelCto[] = latest.map((r) => {
    const livres = r.livres === null || r.livres === undefined ? (r.vagas === null || r.vagas === undefined ? null : Number(r.vagas)) : Number(r.livres);
    const estado: CtoEstado = r.blocked === "conferir" ? "conferir" : (livres ?? 0) > 0 ? "com_vaga" : "sem_vaga";
    return {
      ctoId: String(r.ctoId),
      name: String(r.name),
      regiao: (r.regiao as string | null) ?? null,
      estado,
      livres: estado === "conferir" ? null : livres,
      totalVagas: r.totalVagas === null || r.totalVagas === undefined || Number(r.totalVagas) === 0 ? null : Number(r.totalVagas),
      reservasAbertas: openBy.get(String(r.ctoId)) ?? 0,
      vistoEm: new Date(r.seen as string | Date).toISOString(),
    };
  });

  const byRegion = new Map<string | null, PanelCto[]>();
  for (const c of ctos) {
    const key = c.regiao ? c.regiao.toUpperCase() : null;
    byRegion.set(key, [...(byRegion.get(key) ?? []), c]);
  }
  const regioes: PanelRegion[] = [...byRegion.entries()]
    .map(([regiao, list]) => ({
      regiao,
      ctos: list.sort((a, b) => a.name.localeCompare(b.name)),
      comVaga: list.filter((c) => c.estado === "com_vaga").length,
      semVaga: list.filter((c) => c.estado === "sem_vaga").length,
      conferir: list.filter((c) => c.estado === "conferir").length,
      vagasLivres: list.reduce((s, c) => s + (c.livres ?? 0), 0),
      reservasAbertas: list.reduce((s, c) => s + c.reservasAbertas, 0),
    }))
    // Siglas em ordem alfabética; "sem sigla" por último.
    .sort((a, b) => (a.regiao === null ? 1 : b.regiao === null ? -1 : a.regiao.localeCompare(b.regiao)));

  // Todos os dias do período, inclusive os sem consulta (barra vazia, não buraco no eixo).
  const dailyBy = new Map(daily.map((r) => [String(r.dia), r]));
  const porDia: PanelDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dia = isoDay(new Date(now.getTime() - i * 24 * 3600_000));
    const r = dailyBy.get(dia);
    porDia.push({ dia, viavel: Number(r?.viavel ?? 0), semViabilidade: Number(r?.semViabilidade ?? 0), foraDaArea: Number(r?.foraDaArea ?? 0) });
  }

  const sum = (k: keyof Omit<PanelDay, "dia">) => porDia.reduce((s, d) => s + d[k], 0);
  return {
    days,
    totals: {
      consultas: sum("viavel") + sum("semViabilidade") + sum("foraDaArea"),
      viaveis: sum("viavel"),
      foraDaArea: sum("foraDaArea"),
      reservasAbertas: open.reduce((s, r) => s + Number(r.n), 0),
      ctosVistas: ctos.length,
      ctosConferir: ctos.filter((c) => c.estado === "conferir").length,
    },
    porDia,
    regioes,
  };
}
