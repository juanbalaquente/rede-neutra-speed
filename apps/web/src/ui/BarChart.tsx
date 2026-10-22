import { useState } from "react";

export interface Bar {
  label: string;
  value: number;
}

/** Arredonda o teto do eixo para um número "redondo", com 3 marcas de grade. */
function niceTop(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/**
 * Barras de uma série só: cor única (a série é nomeada pelo título, então sem legenda), ponta
 * arredondada de 4 px, grade discreta, tooltip por barra (mouse e teclado) e visão em tabela.
 */
export function BarChart({ title, bars, unit, format = (n) => String(n) }: { title: string; bars: Bar[]; unit: string; format?: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const top = niceTop(Math.max(0, ...bars.map((b) => b.value)));
  const ticks = [0, top / 2, top];
  const empty = bars.every((b) => b.value === 0);

  return (
    <div className="card">
      <div className="ch">
        <h3>{title}</h3>
        <button className="linkbtn" onClick={() => setTable((t) => !t)}>{table ? "Ver gráfico" : "Ver tabela"}</button>
      </div>
      {table ? (
        <table className="hist">
          <thead><tr><th>Período</th><th style={{ textAlign: "right" }}>{unit}</th></tr></thead>
          <tbody>{bars.map((b) => <tr key={b.label}><td>{b.label}</td><td className="tab">{format(b.value)}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="bars">
          <div className="plot" onMouseLeave={() => setHover(null)} role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${format(b.value)}`).join(", ")}`}>
            {ticks.map((t) => (
              <span key={t}>
                <span className="grid" style={{ bottom: `${(t / top) * 100}%` }} />
                <span className="tick" style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)" }}>{format(t)}</span>
              </span>
            ))}
            {bars.map((b, i) => (
              <button
                key={b.label}
                type="button"
                className="col"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${b.label}: ${format(b.value)} ${unit}`}
              >
                {b.value > 0 && <span className="seg" style={{ height: `calc(${(b.value / top) * 100}% - 2px)`, background: "var(--data)" }} />}
              </button>
            ))}
            {hover !== null && (
              <div className="tip" style={{ left: `${((hover + 0.5) / bars.length) * 100}%`, top: `${Math.max(8, 100 - (bars[hover]!.value / top) * 100) - 4}%`, minWidth: 120 }}>
                <b>{bars[hover]!.label}</b>
                <div><span>{unit}</span><span className="tab">{format(bars[hover]!.value)}</span></div>
              </div>
            )}
          </div>
          <div className="xl">{bars.map((b) => <span key={b.label}>{b.label}</span>)}</div>
          {empty && <p className="muted" style={{ margin: "10px 0 0", fontSize: 12.5 }}>Ainda sem dados neste período.</p>}
        </div>
      )}
    </div>
  );
}
