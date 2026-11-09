const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Centavos em reais, no formato brasileiro (R$ 99,90). */
export const brl = (cents: number) => fmt.format(cents / 100);

/**
 * "99,90", "1.299,90" ou "99.90" em centavos; NaN se não for um valor.
 * Com vírgula, o ponto é milhar; sem vírgula, o ponto é decimal.
 */
export function parseBrl(text: string): number {
  const t = text.trim().replace(/^R\$\s*/, "");
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
