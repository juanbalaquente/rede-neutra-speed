import { useMemo, useState } from "react";
import type { SignalView } from "../clientStatusApi";

const W = 640;
const H = 180;
const PAD = { l: 44, r: 12, t: 12, b: 24 };

const fmt = (n: number) => n.toFixed(1).replace(".", ",");
const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const QUEDA: Record<string, string> = { loss: "sem sinal (loss)", sem_energia: "sem energia", offline: "offline" };

/**
 * Sinal recebido na ONU (dBm) ao longo do período. A linha pontilhada é o pior sinal aceitável (o medido na CTO menos o limite);
 * faixas vermelhas são as quedas. Leitura por teclado e mouse; "Ver tabela" mostra os mesmos pontos em texto.
 */
export function SignalChart({ data }: { data: SignalView }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const { series, referencia } = data;

  const model = useMemo(() => {
    const pts = series.pontos.map((p) => ({ t: new Date(p.em).getTime(), v: p.rxDbm }));
    if (pts.length < 2) return null;
    const t0 = pts[0]!.t;
    const t1 = pts[pts.length - 1]!.t;
    const values = pts.map((p) => p.v).concat(referencia.minimoDbm);
    // Eixo com folga de 1 dB, arredondado: o sinal em dBm é negativo, então "mais alto" é melhor.
    const hi = Math.ceil(Math.max(...values) + 1);
    const lo = Math.floor(Math.min(...values) - 1);
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + ((hi - v) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
    return { pts, t0, t1, hi, lo, x, y };
  }, [series, referencia.minimoDbm]);

  if (!model) return <p className="muted" style={{ margin: 0 }}>Ainda não há leituras de sinal suficientes para o gráfico.</p>;
  const { pts, t0, t1, hi, lo, x, y } = model;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ticks = [hi, (hi + lo) / 2, lo];
  const minY = y(referencia.minimoDbm);
  const h = hover === null ? null : pts[hover]!;
  const below = pts.filter((p) => p.v < referencia.minimoDbm).length;

  function pick(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.t - t) < Math.abs(pts[best]!.t - t)) best = i;
    setHover(best);
  }

  return (
    <div className="sigchart">
      <div className="sig-top">
        <span className="muted" style={{ fontSize: 12.5 }}>
          Mínimo aceitável <b className="mono" style={{ color: "var(--ink)" }}>{fmt(referencia.minimoDbm)} dBm</b>
          {below > 0 ? <> · <span style={{ color: "var(--warn)" }}>{below} leitura{below > 1 ? "s" : ""} abaixo</span></> : null}
        </span>
        <button className="linkbtn" onClick={() => setTable((t) => !t)}>{table ? "Ver gráfico" : "Ver tabela"}</button>
      </div>
      {table ? (
        <div style={{ maxHeight: 220, overflow: "auto" }}>
          <table className="hist">
            <thead><tr><th>Leitura</th><th style={{ textAlign: "right" }}>dBm</th></tr></thead>
            <tbody>{[...pts].reverse().map((p) => <tr key={p.t}><td>{when(p.t)}</td><td className="tab">{fmt(p.v)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="sig-svg"
          role="img"
          aria-label={`Sinal da ONU em ${series.dias} dias: de ${fmt(Math.min(...pts.map((p) => p.v)))} a ${fmt(Math.max(...pts.map((p) => p.v)))} dBm, ${series.quedas.length} queda(s)`}
          onMouseMove={pick}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="sig-grid" />
              <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="sig-tick">{fmt(t)}</text>
            </g>
          ))}
          {series.quedas.map((q) => {
            const a = Math.max(x(new Date(q.inicio).getTime()), PAD.l);
            const b = Math.min(x(q.fim ? new Date(q.fim).getTime() : t1), W - PAD.r);
            return (
              <rect key={q.inicio} x={a} y={PAD.t} width={Math.max(3, b - a)} height={H - PAD.t - PAD.b} className="sig-drop">
                <title>{`Queda: ${QUEDA[q.tipo] ?? q.tipo}, ${when(new Date(q.inicio).getTime())}${q.fim ? ` até ${when(new Date(q.fim).getTime())}` : " (ainda caída)"}`}</title>
              </rect>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={minY} y2={minY} className="sig-min" />
          <path d={path} className="sig-line" />
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={PAD.l + f * (W - PAD.l - PAD.r)} y={H - 6} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="sig-tick">{day(t0 + f * (t1 - t0))}</text>
          ))}
          {h && (
            <g>
              <line x1={x(h.t)} x2={x(h.t)} y1={PAD.t} y2={H - PAD.b} className="sig-cross" />
              <circle cx={x(h.t)} cy={y(h.v)} r={4} className="sig-dot" />
            </g>
          )}
        </svg>
      )}
      {h && !table && <div className="sig-tip">{when(h.t)} · <b className="mono">{fmt(h.v)} dBm</b></div>}
      {series.quedas.length > 0 && !table && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
          {series.quedas.length} queda{series.quedas.length > 1 ? "s" : ""} no período:{" "}
          {series.quedas.map((q) => `${QUEDA[q.tipo] ?? q.tipo} em ${day(new Date(q.inicio).getTime())}`).join(", ")}
        </p>
      )}
    </div>
  );
}
