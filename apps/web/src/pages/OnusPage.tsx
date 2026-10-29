import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "../api";
import { clientStatusApi, type Achado, type OnuDetailView, type OnuItem, type OnuList, type OnuProblema, type SignalView } from "../clientStatusApi";
import { CONTRATO, FIBRA, Light, ago, fmtDbm, pppLight, since } from "../ui/ClientStatusPanel";
import { CustomerActionsPanel } from "../ui/CustomerActionsPanel";
import { SearchIcon } from "../ui/Icons";
import { SignalChart } from "../ui/SignalChart";
import { useToast } from "../ui/Toast";

type Filter = "todas" | "problema" | "bloqueadas";

const PROBLEMA: Record<OnuProblema, string> = {
  falha_rede: "Falha na rede",
  sem_luz: "Sem luz",
  sem_energia: "Sem energia",
  offline: "Offline",
  desabilitada: "Desabilitada",
  pppoe_caido: "PPPoE caído",
  sinal_fraco: "Sinal fraco",
};

/** O detalhe aberto se atualiza sozinho neste intervalo (leitura ao vivo no OLTCloud, pela Wiki). */
const REFRESH_MS = 60_000;

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);
const num = (n: number, digits = 1) => n.toFixed(digits).replace(".", ",");

function duration(iso: string | null): string | null {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 0) return null;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${mins % 60} min`;
  return `${mins} min`;
}

/** Badge do estado de cada ONU na lista. */
function StateBadge({ o }: { o: OnuItem }) {
  if (o.bloqueado) return <span className="badge b-warn">Bloqueado</span>;
  if (o.problema) return <span className={`badge ${o.problema === "sinal_fraco" || o.problema === "sem_energia" || o.problema === "desabilitada" ? "b-warn" : "b-bad"}`}>{PROBLEMA[o.problema]}</span>;
  if (o.fibra === "desconhecido") return <span className="badge b-mute">Sem leitura</span>;
  return <span className="badge b-ok">No ar</span>;
}

/** Régua de cor do sinal óptico: mesma leitura que o suporte da Speed usa (acima de -8 ou abaixo de -30 é crítico, abaixo de -25 é atenção). */
function rxTone(rx: number | null, minimo: number | null): "ok" | "warn" | "bad" | "mute" {
  if (rx === null) return "mute";
  if (rx > -8 || rx < -30) return "bad";
  if (rx < -25 || (minimo !== null && rx < minimo)) return "warn";
  return "ok";
}

function Metric({ label, value, sub, tone = "mute" }: { label: string; value: string; sub?: string | null; tone?: "ok" | "warn" | "bad" | "mute" }) {
  return (
    <div className={`onu-m t-${tone}`}>
      <small>{label}</small>
      <b className="mono">{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function Finding({ a, onTicket, onActions }: { a: Achado; onTicket?: () => void; onActions: () => void }) {
  return (
    <div className={`onu-dx t-${a.tom}`}>
      <div>
        <b>{a.titulo}</b>
        <p>{a.texto}</p>
      </div>
      {a.acao === "chamado" && onTicket && <button className="btn sec sm" onClick={onTicket}>Abrir chamado</button>}
      {(a.acao === "reiniciar" || a.acao === "desbloquear") && <button className="btn sec sm" onClick={onActions}>{a.acao === "reiniciar" ? "Reiniciar ONU" : "Desbloquear"}</button>}
    </div>
  );
}

function Detail({ id, user, onOpenTicket, onOpenInstallation, onChanged }: { id: string; user: User; onOpenTicket?: (id: string) => void; onOpenInstallation?: (id: string) => void; onChanged: () => void }) {
  const say = useToast();
  const [view, setView] = useState<OnuDetailView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  const [signal, setSignal] = useState<SignalView | null>(null);
  const [signalErr, setSignalErr] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (manual: boolean) => {
      setBusy(true);
      try {
        setView(await clientStatusApi.onu(id));
        setErr(null);
        setReadAt(Date.now());
        if (manual) say("ONU consultada agora");
      } catch (e) {
        setErr(errMsg(e, "Falha ao consultar a ONU."));
        if (manual) say(errMsg(e, "Falha ao consultar a ONU."), "bad");
      } finally {
        setBusy(false);
      }
    },
    [id, say],
  );
  useEffect(() => {
    void load(false);
    // Atualiza sozinho só com a aba visível: cada leitura vai ao OLTCloud.
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(false); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    let alive = true;
    setSignal(null);
    setSignalErr(null);
    clientStatusApi.signal(id, days).then((r) => alive && setSignal(r)).catch((e) => alive && setSignalErr(errMsg(e, "Falha ao carregar o sinal.")));
    return () => { alive = false; };
  }, [id, days]);

  // No celular o detalhe fica abaixo da lista: desce até ele ao abrir.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1000px)").matches) top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [id]);

  // Relógio da "idade" da leitura.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  if (!view) {
    return (
      <div className="card onu-detail" ref={top}>
        {err ? <p className="error" role="alert" style={{ padding: 18 }}>{err}</p> : <p className="empty">Consultando a ONU no OLTCloud…</p>}
      </div>
    );
  }

  const { cliente, status: s, detalhe: d, referencia, diagnostico } = view;
  const o = d?.onu;
  const ticket = onOpenTicket ? () => onOpenTicket(cliente.reservationId) : undefined;
  const goActions = () => actions.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  const rx = o ? o.rxDbm : (s?.fibra.sinalDbm ?? null);
  const pon = d?.pon ?? null;
  const ponPct = pon && pon.onus > 0 ? Math.round((pon.offline / pon.onus) * 100) : null;
  const wifi = d?.wifi ?? null;
  const devices = [...(wifi?.dispositivos ?? [])].sort((a, b) => (a.rssiDbm ?? -200) - (b.rssiDbm ?? -200));

  return (
    <div className="card onu-detail" ref={top} style={{ scrollMarginTop: 70 }}>
      <div className="ch">
        <div style={{ minWidth: 0 }}>
          <h3>{cliente.contract ? `Contrato ${cliente.contract}` : cliente.login}{cliente.nickname ? ` · ${cliente.nickname}` : ""}</h3>
          <small>{cliente.ctoName} · {cliente.address}</small>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <small className="muted">{readAt ? `lido ${ago(new Date(readAt).toISOString())}` : ""}</small>
          <button className="btn sec sm" disabled={busy} onClick={() => void load(true)}>{busy ? "Consultando…" : "Atualizar"}</button>
          {onOpenInstallation && <button className="btn sec sm" onClick={() => onOpenInstallation(cliente.reservationId)}>Instalação</button>}
        </div>
      </div>

      <div className="summary">
        {err && <p className="error" role="alert" style={{ margin: 0 }}>{err} Mostrando a última leitura.</p>}
        <div className="onu-dxs" aria-label="Diagnóstico">
          {diagnostico.map((a) => <Finding key={a.codigo} a={a} onTicket={ticket} onActions={goActions} />)}
        </div>

        {s && (
          <div className="lights">
            <Light title="Fibra" label={FIBRA[o?.estado ?? s.fibra.estado].label} tone={FIBRA[o?.estado ?? s.fibra.estado].tone} detail={null} age={d?.lidoEm ?? s.fibra.atualizadoEm} stale={false} />
            <Light title="PPPoE" label={pppLight(s.autenticacao).label} tone={pppLight(s.autenticacao).tone} detail={s.autenticacao.ip} age={s.autenticacao.atualizadoEm} stale={false} />
            <Light title="Contrato" label={CONTRATO[s.contrato.estado].label} tone={CONTRATO[s.contrato.estado].tone} detail={null} age={s.contrato.atualizadoEm} stale={false} />
          </div>
        )}

        {view.detalheProblema === "rota_ausente" && (
          <p className="note" style={{ margin: 0 }}>As potências, a porta da OLT e o Wi-Fi do cliente ainda não estão disponíveis pela Speed. Por enquanto o diagnóstico usa só o semáforo.</p>
        )}
        {view.detalheProblema === "falhou" && <p className="note" style={{ margin: 0 }}>A leitura ao vivo da ONU falhou agora. O diagnóstico usa o semáforo; tente Atualizar em instantes.</p>}

        <div className="onu-ms">
          <Metric label="Sinal na ONU" value={rx === null ? "—" : `${num(rx)} dBm`} sub={`mínimo ${num(referencia.minimoDbm)}`} tone={rxTone(rx, referencia.minimoDbm)} />
          {o && <Metric label="Sinal na OLT" value={o.rxOltDbm === null ? "—" : `${num(o.rxOltDbm)} dBm`} sub="o que volta da casa" tone={rxTone(o.rxOltDbm, null)} />}
          {o && <Metric label="Potência da ONU" value={o.txDbm === null ? "—" : `${num(o.txDbm)} dBm`} sub="saída (TX)" tone={o.txDbm === null ? "mute" : o.txDbm < 0 || o.txDbm > 6 ? "bad" : "ok"} />}
          {o && <Metric label="Temperatura" value={o.temperaturaC === null ? "—" : `${Math.round(o.temperaturaC)} °C`} tone={o.temperaturaC === null ? "mute" : o.temperaturaC >= 70 ? "warn" : "ok"} />}
          {o && <Metric label="Distância da OLT" value={o.distanciaM === null ? "—" : o.distanciaM >= 1000 ? `${num(o.distanciaM / 1000, 2)} km` : `${Math.round(o.distanciaM)} m`} />}
          <Metric
            label={(o?.ligadaDesde ?? s?.fibra.uptimeDesde) ? "No ar há" : "Última queda"}
            value={duration(o?.ligadaDesde ?? s?.fibra.uptimeDesde ?? null) ?? since(o?.ultimaQuedaEm ?? s?.fibra.ultimaQuedaEm ?? null) ?? "—"}
            sub={(o?.ligadaDesde ?? s?.fibra.uptimeDesde) && (o?.ultimaQuedaEm ?? s?.fibra.ultimaQuedaEm) ? `última queda ${since(o?.ultimaQuedaEm ?? s?.fibra.ultimaQuedaEm ?? null)}` : null}
          />
        </div>

        <div className="g3 os-sum">
          <div><small>Login PPPoE</small><span className="mono">{cliente.login}</span></div>
          <div><small>ONU</small><span>{o?.modelo ?? s?.onu?.modelo ?? "ONU"} · <span className="mono">{o?.serial ?? s?.onu?.serial ?? "—"}</span></span></div>
          <div><small>OLT</small><span className="mono">{o?.olt ?? s?.onu?.olt ?? "—"}{o?.slot != null && o?.pon != null ? ` · ${o.slot}/${o.pon}` : ""}</span></div>
        </div>

        {pon && (
          <div className="onu-pon">
            <div className="sig-top">
              <b style={{ fontWeight: 500 }}>Porta da OLT</b>
              <small className="muted">{pon.mediaRxDbm !== null ? `média da porta ${fmtDbm(pon.mediaRxDbm)}` : ""}</small>
            </div>
            <div className="pbar" role="img" aria-label={`${pon.offline} de ${pon.onus} ONUs fora do ar`}>
              <i className={ponPct !== null && ponPct >= 30 ? "bad" : ponPct !== null && ponPct >= 10 ? "warn" : "ok"} style={{ width: `${Math.max(2, ponPct ?? 0)}%` }} />
            </div>
            <small className="muted">
              {pon.offline} de {pon.onus} ONUs desta porta fora do ar{ponPct !== null ? ` (${ponPct}%)` : ""}. Conta todos os clientes da Speed na porta, não só os seus.
            </small>
          </div>
        )}

        {wifi && (
          <div className="onu-wifi">
            <div className="sig-top">
              <b style={{ fontWeight: 500 }}>Wi-Fi do cliente</b>
              <small className="muted">{devices.length} {devices.length === 1 ? "aparelho" : "aparelhos"}{wifi.lidoEm ? ` · lido ${ago(wifi.lidoEm)}` : ""}</small>
            </div>
            {devices.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>Nenhum aparelho conectado no Wi-Fi agora.</p>
            ) : (
              <div className="tscroll">
                <table className="hist">
                  <thead><tr><th>Aparelho</th><th>Rede</th><th className="num">Sinal</th></tr></thead>
                  <tbody>
                    {devices.map((w) => {
                      const tone = w.rssiDbm === null ? "b-mute" : w.rssiDbm < -70 ? "b-bad" : w.rssiDbm < -60 ? "b-warn" : "b-ok";
                      return (
                        <tr key={w.mac}>
                          <td style={{ fontFamily: "var(--font)" }}>{w.nome && w.nome !== "Unknown" ? w.nome : <span className="mono">{w.mac}</span>}</td>
                          <td style={{ fontFamily: "var(--font)" }}>{[w.ssid, w.banda].filter(Boolean).join(" · ") || "—"}</td>
                          <td className="num"><span className={`badge ${tone}`}>{w.rssiDbm === null ? "—" : `${w.rssiDbm} dBm`}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <b style={{ fontWeight: 500 }}>Sinal da ONU</b>
          <div className="seg" role="tablist" aria-label="Período do gráfico" style={{ margin: 0 }}>
            {[7, 30, 90].map((n) => (
              <button key={n} role="tab" aria-selected={days === n} className={days === n ? "on" : ""} onClick={() => setDays(n)}>{n} dias</button>
            ))}
          </div>
        </div>
        {signalErr ? <p className="muted" style={{ margin: 0 }}>{signalErr}</p> : signal ? <SignalChart data={signal} /> : <p className="muted" style={{ margin: 0 }}>Carregando o gráfico…</p>}
      </div>

      {user.role !== "admin_speed" && (
        <div ref={actions}>
          <CustomerActionsPanel installationId={cliente.reservationId} customerStatus={cliente.customerStatus} user={user} onChanged={() => { void load(false); onChanged(); }} />
        </div>
      )}
    </div>
  );
}

/** ONUs: o suporte do parceiro vê todas as ONUs dos clientes e diagnostica um chamado sem ligar para a Speed. */
export function OnusPage({ user, initialId, onOpenTicket, onOpenInstallation }: { user: User; initialId?: string | null; onOpenTicket?: (id: string) => void; onOpenInstallation?: (id: string) => void }) {
  const say = useToast();
  const [list, setList] = useState<OnuList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [filter, setFilter] = useState<Filter>("todas");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (initialId) setSelected(initialId);
  }, [initialId]);

  const load = useCallback(() => {
    clientStatusApi
      .onus()
      .then((r) => { setList(r); setFailed(null); })
      .catch((e) => { setFailed(errMsg(e, "Falha ao carregar as ONUs.")); setList((cur) => cur ?? { onus: [], leituraIndisponivel: true, atualizadoEm: null }); });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 120_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { if (failed) say(failed, "bad"); }, [failed, say]);

  const all = list?.onus ?? [];
  const problemas = all.filter((o) => o.problema).length;
  const bloqueadas = all.filter((o) => o.bloqueado).length;
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const has = (v: string | null) => !!v && v.toLowerCase().includes(term);
    return all
      .filter((o) => (filter === "problema" ? !!o.problema : filter === "bloqueadas" ? o.bloqueado : true))
      .filter((o) => !term || has(o.contract) || has(o.nickname) || has(o.login) || has(o.serial) || has(o.ctoName) || has(o.address))
      // Com problema primeiro: é por onde o suporte começa.
      .sort((a, b) => Number(!!b.problema) - Number(!!a.problema));
  }, [all, filter, q]);

  const FILTERS: [Filter, string][] = [["todas", `Todas ${all.length}`], ["problema", `Com problema ${problemas}`], ["bloqueadas", `Bloqueadas ${bloqueadas}`]];

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>ONUs</h1>
          <p>Todas as ONUs dos seus clientes, com o diagnóstico ao vivo da rede para atender o assinante.</p>
        </div>
        {list?.atualizadoEm && <small className="muted">Lista lida {ago(list.atualizadoEm)}</small>}
      </div>

      {list?.leituraIndisponivel && <div className="banner warn" role="status" style={{ margin: 0 }}>A Speed não respondeu agora: a lista aparece sem o estado de cada ONU. Abra uma para consultar.</div>}

      <div className="onu-split">
        <div className="card onu-list">
          <div className="onu-tools">
            <label className="onu-search">
              <SearchIcon />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Contrato, cliente, serial ou CTO" aria-label="Buscar ONU" />
            </label>
            <div className="seg" role="tablist" aria-label="Filtro">
              {FILTERS.map(([f, label]) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{label}</button>
              ))}
            </div>
          </div>
          {list === null ? (
            <p className="empty">Carregando…</p>
          ) : all.length === 0 ? (
            <p className="empty">Nenhum cliente instalado ainda. A ONU aparece aqui quando a O.S. é fechada.</p>
          ) : shown.length === 0 ? (
            <p className="empty">Nenhuma ONU neste filtro.</p>
          ) : (
            <ul className="onu-rows">
              {shown.map((o) => (
                <li key={o.reservationId}>
                  <button className={`onu-row ${o.reservationId === selected ? "on" : ""}`} onClick={() => setSelected(o.reservationId)} aria-current={o.reservationId === selected}>
                    <span className="onu-row-main">
                      <b>{o.contract ?? o.login}{o.nickname ? ` · ${o.nickname}` : ""}</b>
                      <small>{o.ctoName}</small>
                    </span>
                    <span className="onu-row-side">
                      <StateBadge o={o} />
                      <small className="mono">{o.sinalDbm === null ? "—" : `${num(o.sinalDbm)} dBm`}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected ? (
          <Detail key={selected} id={selected} user={user} onOpenTicket={onOpenTicket} onOpenInstallation={onOpenInstallation} onChanged={load} />
        ) : (
          <div className="card onu-detail onu-pick">
            <p className="empty">Escolha uma ONU na lista para ver o diagnóstico: luz chegando, energia, porta da OLT, PPPoE e o Wi-Fi do cliente.</p>
          </div>
        )}
      </div>
    </main>
  );
}
