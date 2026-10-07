import { useEffect, useState } from "react";
import { api, type NetworkPanel, type PanelCto, type PanelDay, type PanelRegion } from "../api";

const PERIODS = [7, 30, 90];

/** Categorias de consulta: ordem fixa dos slots 1 a 3 (validada nos dois temas). */
const SERIES: { key: keyof Omit<PanelDay, "dia">; label: string; color: string }[] = [
  { key: "viavel", label: "Com viabilidade", color: "var(--series-1)" },
  { key: "semViabilidade", label: "Sem viabilidade", color: "var(--series-2)" },
  { key: "foraDaArea", label: "Fora da área", color: "var(--series-3)" },
];

/** Ocupação em 5 faixas (sequencial azul, clara = vazia). */
const BINS = ["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"];
const BIN_LABEL = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];

const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

function occupancy(c: PanelCto): number | null {
  if (c.estado === "conferir" || c.livres === null || !c.totalVagas) return null;
  return Math.min(1, Math.max(0, 1 - c.livres / c.totalVagas));
}
const binOf = (o: number) => Math.min(4, Math.floor(o * 5));

/** Escala "bonita" para o eixo: 4 linhas de grade em múltiplos de 1, 2, 5 ou 10. */
function niceMax(max: number): { top: number; step: number } {
  if (max <= 4) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { top: step * 4, step };
}

function DailyChart({ days }: { days: PanelDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const totals = days.map((d) => d.viavel + d.semViabilidade + d.foraDaArea);
  const { top, step } = niceMax(Math.max(0, ...totals));
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const labelEvery = Math.ceil(days.length / 8);

  return (
    <div className="card">
      <div className="ch">
        <h3>Consultas de parceiros por dia</h3>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <div className="legend">
            {SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
          </div>
          <button className="linkbtn" onClick={() => setTable((t) => !t)}>{table ? "Ver gráfico" : "Ver tabela"}</button>
        </div>
      </div>
      {table ? (
        <table className="hist">
          <thead><tr><th>Dia</th>{SERIES.map((s) => <th key={s.key}>{s.label}</th>)}<th>Total</th></tr></thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d.dia}><td>{fmtDay(d.dia)}</td>{SERIES.map((s) => <td key={s.key} className="tab">{d[s.key]}</td>)}<td className="tab">{totals[i]}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="bars">
          <div className="plot" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <span key={t}>
                <span className="grid" style={{ bottom: `${(t / top) * 100}%` }} />
                <span className="tick" style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)" }}>{t}</span>
              </span>
            ))}
            {days.map((d, i) => (
              <button
                key={d.dia}
                className="col"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${fmtDay(d.dia)}: ${SERIES.map((s) => `${s.label} ${d[s.key]}`).join(", ")}`}
              >
                {SERIES.map((s) =>
                  d[s.key] > 0 ? <span key={s.key} className="seg" style={{ height: `calc(${(d[s.key] / top) * 100}% - 2px)`, background: s.color }} /> : null,
                )}
              </button>
            ))}
            {hover !== null && days[hover] && (
              <div className="tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%`, top: `${Math.max(8, 100 - (totals[hover]! / top) * 100) - 4}%` }}>
                <b>{fmtDay(days[hover]!.dia)} · {totals[hover]} consultas</b>
                {SERIES.map((s) => (
                  <div key={s.key}><span><i style={{ background: s.color }} />{s.label}</span><span className="tab">{days[hover]![s.key]}</span></div>
                ))}
              </div>
            )}
          </div>
          <div className="xl">
            {days.map((d, i) => <span key={d.dia} style={{ visibility: i === days.length - 1 || (i % labelEvery === 0 && days.length - 1 - i >= labelEvery) ? "visible" : "hidden" }}>{fmtDay(d.dia)}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function RegionCard({ region }: { region: PanelRegion }) {
  const [hover, setHover] = useState<{ cto: PanelCto; x: number; y: number; flip: "left" | "right" | null } | null>(null);
  const [table, setTable] = useState(false);
  const estado = (c: PanelCto) => (c.estado === "conferir" ? "A Speed precisa conferir" : c.estado === "com_vaga" ? "Com vaga" : "Sem vaga");

  return (
    <div className="card">
      <div className="ch">
        <div className="rhead">
          <h3>{region.regiao ?? "Sem sigla"}</h3>
          <span><b>{region.ctos.length}</b> CTOs vistas</span>
          <span><b>{region.comVaga}</b> com vaga</span>
          <span><b>{region.semVaga}</b> sem vaga</span>
          <span><b>{region.conferir}</b> para conferir</span>
          <span><b>{region.vagasLivres}</b> vagas livres</span>
          <span><b>{region.reservasAbertas}</b> reservas abertas</span>
        </div>
        <button className="linkbtn" onClick={() => setTable((t) => !t)}>{table ? "Ver mapa" : "Ver tabela"}</button>
      </div>
      {table ? (
        <table className="hist">
          <thead><tr><th>CTO</th><th>Situação</th><th>Vagas livres</th><th>Reservas</th><th>Última leitura</th></tr></thead>
          <tbody>
            {region.ctos.map((c) => (
              <tr key={c.ctoId}>
                <td>{c.name}</td>
                <td style={{ fontFamily: "var(--font)" }}>{estado(c)}</td>
                <td className="tab">{c.livres === null ? "—" : `${c.livres}${c.totalVagas ? ` de ${c.totalVagas}` : ""}`}</td>
                <td className="tab">{c.reservasAbertas}</td>
                <td className="tab">{fmtWhen(c.vistoEm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div className="heat" onMouseLeave={() => setHover(null)}>
            {region.ctos.map((c) => {
              const o = occupancy(c);
              const show = (el: HTMLElement) => {
                const box = el.parentElement!.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                const x = r.left - box.left + r.width / 2;
                // Abre abaixo da célula; perto da borda, ancora na lateral para não sair do cartão.
                const flip = x < 110 ? "left" : x > box.width - 110 ? "right" : null;
                setHover({ cto: c, x: flip === "left" ? r.left - box.left : flip === "right" ? r.right - box.left : x, y: r.bottom - box.top + 6, flip });
              };
              return (
                <button
                  key={c.ctoId}
                  className={o === null ? "none" : ""}
                  style={o === null ? undefined : { background: BINS[binOf(o)] }}
                  onMouseEnter={(e) => show(e.currentTarget)}
                  onFocus={(e) => show(e.currentTarget)}
                  onBlur={() => setHover(null)}
                  aria-label={`${c.name}: ${estado(c)}${c.livres !== null ? `, ${c.livres} vagas livres` : ""}${c.reservasAbertas ? `, ${c.reservasAbertas} reservas abertas` : ""}`}
                >
                  {c.reservasAbertas > 0 && <span className="dot" />}
                </button>
              );
            })}
            {hover && (
              <div className="tip" style={{ left: hover.x, top: hover.y, transform: hover.flip === "left" ? "none" : hover.flip === "right" ? "translateX(-100%)" : "translateX(-50%)" }}>
                <b className="mono">{hover.cto.name}</b>
                <div><span>Situação</span><span>{estado(hover.cto)}</span></div>
                {hover.cto.livres !== null && <div><span>Vagas livres</span><span className="tab">{hover.cto.livres}{hover.cto.totalVagas ? ` de ${hover.cto.totalVagas}` : ""}</span></div>}
                <div><span>Reservas abertas</span><span className="tab">{hover.cto.reservasAbertas}</span></div>
                <div><span>Última leitura</span><span className="tab">{fmtWhen(hover.cto.vistoEm)}</span></div>
              </div>
            )}
          </div>
          <div className="scale">
            <span>Ocupação</span>
            <span className="sw">{BINS.map((b, i) => <i key={b} style={{ background: b }} title={BIN_LABEL[i]} />)}</span>
            <span>vazia → cheia</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
              <i style={{ width: 12, height: 12, borderRadius: 3, background: "var(--viz-none)", boxShadow: "inset 0 0 0 1.5px var(--c-warn)", display: "inline-block" }} />
              para conferir
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
              <i style={{ width: 6, height: 6, borderRadius: "50%", boxShadow: "0 0 0 1px var(--ink)", display: "inline-block" }} />
              reserva aberta
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Administrador Speed: demanda dos parceiros e estado das CTOs vistas, por sigla. */
export function PanelPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<NetworkPanel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .painel(days)
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Falha ao carregar."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [days]);

  const t = data?.totals;
  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Painel da rede</h1>
          <p>O que os parceiros procuram e como estão as CTOs que eles encontram.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {PERIODS.map((p) => <button key={p} className={`btn sm ${p === days ? "" : "sec"}`} onClick={() => setDays(p)}>{p} dias</button>)}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {data && t && (
        // Recarregando: mantém o painel anterior esmaecido, sem pular o layout.
        <div style={{ display: "grid", gap: 14, opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}>
          <div className="kpis">
            <div className="card kpi"><span>Consultas</span><b>{t.consultas}</b><small>nos últimos {data.days} dias</small></div>
            <div className="card kpi"><span>Com viabilidade</span><b>{pct(t.viaveis, t.consultas)}</b><small>{t.viaveis} consultas</small></div>
            <div className="card kpi"><span>Fora da área</span><b>{t.foraDaArea}</b><small>demanda fora do piloto</small></div>
            <div className="card kpi"><span>Reservas abertas</span><b>{t.reservasAbertas}</b><small>agora</small></div>
            <div className="card kpi"><span>CTOs para conferir</span><b>{t.ctosConferir}</b><small>de {t.ctosVistas} vistas</small></div>
          </div>
          <DailyChart days={data.porDia} />
          {data.regioes.length === 0 ? (
            <p className="note">Nenhuma CTO apareceu em consultas neste período.</p>
          ) : (
            data.regioes.map((r) => <RegionCard key={r.regiao ?? "sem-sigla"} region={r} />)
          )}
          <p className="note">
            O mapa mostra só as CTOs que apareceram em alguma consulta do período, no último estado lido. Não é a rede inteira: o mapa completo por sigla depende de uma rota da Wiki.
          </p>
        </div>
      )}
    </main>
  );
}
