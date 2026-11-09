import { useId, useState, type ReactNode } from "react";

/** Gráficos do portal. Só tokens do tema (--series-*, --data, --viz-*, --ok/--warn/--bad), então valem nos três temas. */

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const monthShort = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m;

/** Teto "redondo" do eixo, com 3 marcas. */
export function niceTop(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Tira os meses vazios do começo da série, mantendo ao menos `min` pontos (um gráfico de um ponto só não conta nada). */
export function trimLeading<T>(rows: T[], has: (r: T) => boolean, min = 3): T[] {
  const first = rows.findIndex(has);
  if (first < 0) return rows.slice(-min);
  return rows.slice(Math.min(first, rows.length - min));
}

export interface AreaPoint {
  label: string;
  value: number;
}

/**
 * Área de uma série com crosshair: linha, preenchimento suave, ponto final marcado e tooltip por passagem do mouse ou
 * do teclado. `goal` desenha a linha de meta. Com poucos pontos, o gráfico continua legível (sem meses vazios).
 */
export function AreaChart({ points, unit, format = (n) => String(n), goal, height = 190 }: { points: AreaPoint[]; unit: string; format?: (n: number) => string; goal?: number | null; height?: number }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 200;
  const pad = { l: 8, r: 8, t: 14, b: 4 };
  const max = Math.max(1, ...points.map((p) => p.value), goal ?? 0);
  const top = niceTop(max);
  const x = (i: number) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad.b} L${x(0).toFixed(1)},${H - pad.b} Z`;
  const last = points[points.length - 1];
  const ticks = [0, top / 2, top];

  return (
    <div className="area" onMouseLeave={() => setHover(null)}>
      <div className="area-in" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }} role="img" aria-label={`${unit}: ${points.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--data)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--data)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t) => <line key={t} x1={0} x2={W} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        {goal ? <line x1={0} x2={W} y1={y(goal)} y2={y(goal)} stroke="var(--brand)" strokeWidth="1.5" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" /> : null}
        <path d={area} fill={`url(#g${id})`} />
        <path d={line} fill="none" stroke="var(--data)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--dim)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* Valores do eixo e pontos ficam fora do SVG esticado, para o texto e os círculos não deformarem. */}
      {[top, top / 2].map((t) => <span key={t} className="area-tick" style={{ top: `${(y(t) / H) * height}px` }}>{format(t)}</span>)}
      {last && (
        <span className="area-dot" style={{ left: `${(x(points.length - 1) / W) * 100}%`, top: `${(y(last.value) / H) * height}px` }} />
      )}
      {hover !== null && points[hover] && (
        <span className="area-dot hot" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(points[hover]!.value) / H) * height}px` }} />
      )}
      <div className="area-hit">
        {points.map((p, i) => (
          <button key={p.label + i} type="button" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${p.label}: ${format(p.value)} ${unit}`} />
        ))}
      </div>
      {hover !== null && points[hover] && (
        <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: Math.max(6, (y(points[hover]!.value) / H) * height - 12), minWidth: 110 }}>
          <b>{points[hover]!.label}</b>
          <div><span>{unit}</span><span className="tab">{format(points[hover]!.value)}</span></div>
        </div>
      )}
      {goal ? <span className="area-goal">meta {format(goal)}</span> : null}
      </div>
      <div className="area-x">
        {points.map((p, i) => <span key={p.label + i} style={{ visibility: points.length <= 8 || i % 2 === (points.length - 1) % 2 ? "visible" : "hidden" }}>{p.label}</span>)}
      </div>
    </div>
  );
}

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
}

/** Donut com o total e o percentual da primeira fatia (a "saudável") no centro; a legenda clicável fica ao lado. */
export function Donut({ slices, centerLabel, size = 132 }: { slices: DonutSlice[]; centerLabel: string; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 38;
  const c = 2 * Math.PI * r;
  let acc = 0;
  const first = slices[0];
  const pct = total > 0 && first ? Math.round((first.value / total) * 100) : 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={`${centerLabel}: ${slices.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--hover)" strokeWidth="13" />
        <g transform="rotate(-90 50 50)" fill="none" strokeWidth="13">
          {total > 0 && slices.filter((s) => s.value > 0).map((s) => {
            const len = (s.value / total) * c;
            const el = <circle key={s.label} cx="50" cy="50" r={r} stroke={s.color} strokeDasharray={`${Math.max(0, len - (slices.filter((x) => x.value > 0).length > 1 ? 1.6 : 0))} ${c}`} strokeDashoffset={-acc} />;
            acc += len;
            return el;
          })}
        </g>
        <text x="50" y="49" textAnchor="middle" fontSize="19" fontWeight="600" fill="var(--ink)" style={{ fontFamily: "var(--font)", letterSpacing: "-0.03em" }}>{total > 0 ? `${pct}%` : "—"}</text>
        <text x="50" y="62" textAnchor="middle" fontSize="7.5" fill="var(--mute)" style={{ fontFamily: "var(--font)" }}>{centerLabel}</text>
      </svg>
      <ul className="donut-leg">
        {slices.map((s) => (
          <li key={s.label}>
            <button type="button" className="rowbtn" onClick={s.onClick} disabled={!s.onClick} style={{ cursor: s.onClick ? "pointer" : "default" }}>
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              <b className="tab">{s.value}</b>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mini-gráfico de linha para tabelas e cartões: sem eixos, ponto final marcado. */
export function Sparkline({ values, width = 84, height = 24, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return <span className="muted">—</span>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const px = (i: number) => 2 + (i / (values.length - 1)) * (width - 4);
  const py = (v: number) => 3 + (1 - (v - min) / span) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const lastV = values[values.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `Evolução: ${values.join(", ")}`} style={{ display: "block", flex: "none" }}>
      <path d={d} fill="none" stroke="var(--data)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={px(values.length - 1)} cy={py(lastV)} r="2.6" fill="var(--data)" />
    </svg>
  );
}

export interface HBarRow {
  label: string;
  value: number;
  /** Texto à direita; por padrão, o próprio valor. */
  display?: string;
  color?: string;
  hint?: string;
}

/** Barras horizontais com rótulo e valor, para funil, ocupação e margem. `max` fixa a escala (100 para percentuais). */
export function HBars({ rows, max }: { rows: HBarRow[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.label} className="hbar" title={r.hint}>
          <span className="hl">{r.label}</span>
          <span className="ht"><i style={{ width: `${Math.max(r.value > 0 ? 2 : 0, Math.min(100, (r.value / top) * 100))}%`, background: r.color ?? "var(--data)" }} /></span>
          <b className="tab hv">{r.display ?? r.value}</b>
        </div>
      ))}
    </div>
  );
}

export interface GroupBar {
  label: string;
  a: number;
  b: number;
}

/** Duas séries lado a lado por período (ex.: custo e faturamento), com grade, tooltip e legenda. */
export function PairBars({ rows, aLabel, bLabel, aColor = "var(--viz-axis)", bColor = "var(--data)", format }: { rows: GroupBar[]; aLabel: string; bLabel: string; aColor?: string; bColor?: string; format: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceTop(Math.max(0, ...rows.flatMap((r) => [r.a, r.b])));
  const ticks = [0, top / 2, top];
  return (
    <div>
      <div className="legend" style={{ padding: "0 18px 4px" }}>
        <span><i style={{ background: aColor }} />{aLabel}</span>
        <span><i style={{ background: bColor }} />{bLabel}</span>
      </div>
      <div className="bars">
        <div className="plot" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <span key={t}>
              <span className="grid" style={{ bottom: `${(t / top) * 100}%` }} />
              <span className="tick" style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)", width: 52, left: -56 }}>{format(t)}</span>
            </span>
          ))}
          {rows.map((r, i) => (
            <button key={r.label} type="button" className="col pair" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${r.label}: ${aLabel} ${format(r.a)}, ${bLabel} ${format(r.b)}`}>
              <span className="pair-in">
                <span className="seg" style={{ height: `${(r.a / top) * 100}%`, background: aColor }} />
                <span className="seg" style={{ height: `${(r.b / top) * 100}%`, background: bColor }} />
              </span>
            </button>
          ))}
          {hover !== null && rows[hover] && (
            <div className="tip" style={{ left: `${((hover + 0.5) / rows.length) * 100}%`, top: "4%" }}>
              <b>{rows[hover]!.label}</b>
              <div><span><i style={{ background: aColor }} />{aLabel}</span><span className="tab">{format(rows[hover]!.a)}</span></div>
              <div><span><i style={{ background: bColor }} />{bLabel}</span><span className="tab">{format(rows[hover]!.b)}</span></div>
            </div>
          )}
        </div>
        <div className="xl" style={{ gap: 2 }}>{rows.map((r) => <span key={r.label} style={{ flex: 1, textAlign: "center" }}>{r.label}</span>)}</div>
      </div>
    </div>
  );
}

/** Cabeçalho de cartão com título, nota e ação à direita. */
export function CardHead({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="ch">
      <div><h3>{title}</h3>{note ? <small>{note}</small> : null}</div>
      {right}
    </div>
  );
}
