import { useEffect, useMemo, useState } from "react";
import { request } from "../api";

type Estado = "com_vaga" | "sem_vaga" | "conferir";

interface RegionCto {
  ctoId: string;
  name: string;
  estado: Estado;
  livres: number;
  totalVagas: number;
  reservasAbertas: number;
  location: { lat: number; lng: number } | null;
  atualizadoEm: string | null;
}

interface RegionMapView {
  regiao: string;
  atualizadoEm: string;
  totais: { ctos: number; comVaga: number; semVaga: number; conferir: number; vagasLivres: number; totalVagas: number; semLocalizacao: number };
  ctos: RegionCto[];
}

const SIGLAS = ["R1", "ITA", "FAT"];
const COLOR: Record<Estado, string> = { com_vaga: "var(--ok)", sem_vaga: "var(--dim)", conferir: "var(--warn)" };
const LABEL: Record<Estado, string> = { com_vaga: "Com vaga", sem_vaga: "Sem vaga", conferir: "Conferir" };

const W = 720;
const H = 380;
const PAD = 16;

const fmtWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Rede inteira de uma sigla (rota v1.1 da Wiki): cada CTO é um ponto, colorido pelo estado.
 * Sem mapa de fundo, só a posição relativa; passar o mouse ou focar mostra o nome e as vagas.
 */
export function RegionMapCard() {
  const [sigla, setSigla] = useState(SIGLAS[0]!);
  const [data, setData] = useState<RegionMapView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<RegionCto | null>(null);
  const [only, setOnly] = useState<Estado | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setHover(null);
    request<RegionMapView>("GET", `/admin/painel/regioes/${sigla}`)
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && (setData(null), setError(e instanceof Error ? e.message : "Falha ao carregar.")))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [sigla]);

  const proj = useMemo(() => {
    const pts = (data?.ctos ?? []).filter((c): c is RegionCto & { location: { lat: number; lng: number } } => c.location !== null);
    if (!pts.length) return null;
    const lat0 = pts.reduce((s, p) => s + p.location.lat, 0) / pts.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = pts.map((p) => p.location.lng * k);
    const ys = pts.map((p) => -p.location.lat);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 0.001), spanY = Math.max(maxY - minY, 0.001);
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
    return { pts, at: (p: { lat: number; lng: number }) => ({ x: offX + (p.lng * k - minX) * scale, y: offY + (-p.lat - minY) * scale }) };
  }, [data]);

  const t = data?.totais;
  const problems = (data?.ctos ?? []).filter((c) => (only ? c.estado === only : c.estado !== "com_vaga")).slice(0, 12);

  return (
    <div className="card">
      <div className="ch">
        <h3>Rede inteira por sigla</h3>
        <div className="seg" role="tablist" aria-label="Sigla" style={{ margin: 0 }}>
          {SIGLAS.map((s) => <button key={s} role="tab" aria-selected={s === sigla} className={s === sigla ? "on" : ""} onClick={() => setSigla(s)}>{s}</button>)}
        </div>
      </div>
      <div className="summary" style={{ display: "grid", gap: 12, opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}>
        {error && <p className="error">{error}</p>}
        {!error && !data && <p className="muted" style={{ margin: 0 }}>Carregando…</p>}
        {data && t && (
          <>
            <div className="regmap-kpis">
              <div><b>{t.ctos}</b><small>CTOs com caixa no OLTCloud</small></div>
              <div><b>{t.vagasLivres}</b><small>vagas livres de {t.totalVagas}</small></div>
              {(["com_vaga", "sem_vaga", "conferir"] as Estado[]).map((e) => {
                const n = e === "com_vaga" ? t.comVaga : e === "sem_vaga" ? t.semVaga : t.conferir;
                return (
                  <button key={e} type="button" className={`regmap-chip ${only === e ? "on" : ""}`} onClick={() => setOnly(only === e ? null : e)} aria-pressed={only === e}>
                    <i style={{ background: COLOR[e] }} aria-hidden="true" />{LABEL[e]} <b>{n}</b>
                  </button>
                );
              })}
            </div>
            {proj ? (
              <div style={{ position: "relative" }}>
                <svg viewBox={`0 0 ${W} ${H}`} className="regmap-svg" role="img" aria-label={`Mapa de ${data.regiao}: ${t.comVaga} CTOs com vaga, ${t.semVaga} sem vaga, ${t.conferir} para conferir`} onMouseLeave={() => setHover(null)}>
                  {proj.pts.map((c) => {
                    const { x, y } = proj.at(c.location);
                    const dim = only !== null && c.estado !== only;
                    return (
                      <circle
                        key={c.ctoId}
                        cx={x}
                        cy={y}
                        r={hover?.ctoId === c.ctoId ? 6 : 4}
                        fill={COLOR[c.estado]}
                        opacity={dim ? 0.15 : 0.85}
                        tabIndex={0}
                        onMouseEnter={() => setHover(c)}
                        onFocus={() => setHover(c)}
                      >
                        <title>{`${c.name}: ${c.estado === "conferir" ? "conferir" : `${c.livres} de ${c.totalVagas} vagas`}`}</title>
                      </circle>
                    );
                  })}
                </svg>
                {hover && (
                  <div className="regmap-tip">
                    <b className="mono">{hover.name}</b> · {LABEL[hover.estado]}
                    {hover.estado !== "conferir" && <> · {hover.livres} de {hover.totalVagas} vagas</>}
                    {hover.reservasAbertas > 0 && <> · {hover.reservasAbertas} reserva(s) aberta(s)</>}
                  </div>
                )}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Nenhuma CTO desta sigla tem posição no mapa.</p>
            )}
            {t.semLocalizacao > 0 && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{t.semLocalizacao} CTO(s) sem posição não aparecem no mapa.</p>}
            <div>
              <b style={{ fontWeight: 500 }}>{only ? LABEL[only] : "Sem vaga ou para conferir"}</b>
              {problems.length === 0 ? (
                <p className="muted" style={{ margin: "4px 0 0" }}>Nenhuma CTO neste filtro.</p>
              ) : (
                <table className="hist">
                  <tbody>
                    {problems.map((c) => (
                      <tr key={c.ctoId}>
                        <td className="mono">{c.name}</td>
                        <td><span className={`badge ${c.estado === "conferir" ? "b-warn" : c.estado === "sem_vaga" ? "b-mute" : "b-ok"}`}>{LABEL[c.estado]}</span></td>
                        <td className="tab">{c.estado === "conferir" ? "—" : `${c.livres}/${c.totalVagas}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <small className="muted">Dado da Wiki de {fmtWhen(data.atualizadoEm)} (atualiza a cada 15 min).</small>
          </>
        )}
      </div>
    </div>
  );
}
