/** Acima disso a ocupação lida é velha demais para vender porta (a Wiki aplica o mesmo limite; aqui é a segunda barreira). */
export const STALE_AFTER_MS = 60 * 60_000;

/** Sem data, ou com data ilegível, o dado conta como velho: ausência de informação não é dado fresco. */
export function isStale(updatedAt: string | null, now = Date.now()): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  return !Number.isFinite(t) || now - t > STALE_AFTER_MS;
}
