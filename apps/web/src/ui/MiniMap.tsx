import type { ViabilityCto } from "../api";

const W = 400;
const H = 170;
const PAD = 34;

interface P {
  x: number;
  y: number;
}

/** Projeta o endereço e as CTOs no quadro, preservando proporção (longitude encolhida pelo cosseno da latitude). */
function projector(pts: { lat: number; lng: number }[]) {
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 0.0006);
  const spanY = Math.max(maxY - minY, 0.0006);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  return (p: { lat: number; lng: number }): P => ({ x: offX + (p.lng * k - minX) * scale, y: offY + (-p.lat - minY) * scale });
}

const short = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);

export function MiniMap({
  point,
  ctos,
  selectedId,
}: {
  point: { lat: number; lng: number } | null;
  ctos: ViabilityCto[];
  selectedId: string | null;
}) {
  const located = ctos.filter((c): c is ViabilityCto & { location: { lat: number; lng: number } } => c.location !== null);
  if (!point || located.length === 0) {
    return <div className="mini-map"><div className="none">{point ? "Sem CTO com posição no mapa" : "Informe um endereço para ver as caixas"}</div></div>;
  }
  const project = projector([point, ...located.map((c) => c.location)]);
  const home = project(point);
  const target = located.find((c) => c.ctoId === selectedId) ?? located[0]!;
  const t = project(target.location);

  return (
    <div className="mini-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Posição do endereço e das caixas próximas">
        <path className="fb" d={`M${home.x} ${home.y} L${t.x} ${t.y}`} />
        {located.map((c) => {
          const p = project(c.location);
          const full = c.blockedReason !== null;
          return (
            <g key={c.ctoId}>
              <circle className={`cto ${full ? "full" : ""}`} cx={p.x} cy={p.y} r={c.ctoId === selectedId ? 7 : 5} />
              <text x={p.x + 10} y={p.y + 3}>{short(c.name)}</text>
            </g>
          );
        })}
        <circle className="home" cx={home.x} cy={home.y} r={5} />
      </svg>
    </div>
  );
}
