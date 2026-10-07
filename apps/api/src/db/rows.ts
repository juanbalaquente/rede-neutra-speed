/** Linhas de um db.execute(sql): postgres-js devolve a lista direto; PGlite devolve { rows }. */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows) as Record<string, unknown>[];
}
