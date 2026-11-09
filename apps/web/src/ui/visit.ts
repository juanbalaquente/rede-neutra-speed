import type { VisitPeriod } from "../api";

export const PERIODS: { id: VisitPeriod; label: string; hours: string; ref: string }[] = [
  { id: "manha", label: "Manhã", hours: "8h às 12h", ref: "08" },
  { id: "tarde", label: "Tarde", hours: "13h às 18h", ref: "14" },
];

export const periodLabel = (p: VisitPeriod) => PERIODS.find((x) => x.id === p)!.label;

/** Período de uma visita: o gravado ou, em visita antiga, o da hora (antes do meio-dia é manhã). */
export const periodOf = (iso: string, period?: VisitPeriod | null): VisitPeriod => period ?? (new Date(iso).getHours() < 12 ? "manha" : "tarde");

const pad = (n: number) => String(n).padStart(2, "0");

/** Dia local como `YYYY-MM-DD`, o formato de `<input type="date">`. */
export const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Instante de referência do período (Brasília); o servidor normaliza do mesmo jeito. */
export const visitInstant = (date: string, period: VisitPeriod) => `${date}T${PERIODS.find((x) => x.id === period)!.ref}:00:00-03:00`;

/** "20/10 · Manhã", com o ano quando não é o corrente (para data antiga não passar por atual). */
export function fmtVisit(iso: string, period?: VisitPeriod | null): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}) });
  return `${day} · ${periodLabel(periodOf(iso, period))}`;
}
