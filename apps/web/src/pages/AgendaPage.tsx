import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { api, type AgendaVisit, type User, type VisitPeriod } from "../api";
import { useToast } from "../ui/Toast";
import { PERIODS, periodLabel, toDateInput, visitInstant } from "../ui/visit";

type View = "dia" | "semana" | "mes";

const DAY = 24 * 3600_000;
const WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
/** Segunda-feira da semana de `d`. */
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

function rangeFor(view: View, anchor: Date): { from: Date; to: Date; days: Date[] } {
  if (view === "dia") {
    const from = startOfDay(anchor);
    return { from, to: addDays(from, 1), days: [from] };
  }
  if (view === "semana") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7), days: Array.from({ length: 7 }, (_, i) => addDays(from, i)) };
  }
  const from = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return { from, to: addDays(from, 42), days: Array.from({ length: 42 }, (_, i) => addDays(from, i)) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function titleFor(view: View, anchor: Date, days: Date[]): string {
  if (view === "mes") return anchor.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  if (view === "dia") return anchor.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const a = days[0]!;
  const b = days[6]!;
  return `${a.getDate()} ${a.toLocaleDateString("pt-BR", { month: "short" })} a ${b.getDate()} ${b.toLocaleDateString("pt-BR", { month: "short", year: "numeric" })}`;
}

const STATUS: Record<AgendaVisit["visitStatus"], { label: string; tone: string }> = {
  agendada: { label: "Agendada", tone: "b-data" },
  em_execucao: { label: "Em execução", tone: "b-warn" },
  concluida: { label: "Concluída", tone: "b-ok" },
  reagendada: { label: "Reagendada", tone: "b-mute" },
};

/** Visita que passou do dia sem ser concluída (melhoria sugerida no planejamento). */
const isLate = (v: AgendaVisit, now: Date) => v.visitStatus !== "concluida" && !v.osClosedAt && startOfDay(new Date(v.visitAt)) < startOfDay(now);

function VisitCard({ v, now, compact, draggable, onOpen, onDragStart }: { v: AgendaVisit; now: Date; compact: boolean; draggable: boolean; onOpen: () => void; onDragStart: (e: DragEvent) => void }) {
  const late = isLate(v, now);
  return (
    <button
      type="button"
      className={`ag-card st-${v.visitStatus} ${late ? "late" : ""} ${compact ? "compact" : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
      title={`${v.nickname ?? v.contract ?? "Sem contrato"} · ${v.technician ?? ""}`}
    >
      {compact && <span className="t">{periodLabel(v.visitPeriod)}</span>}
      <span className="n">{v.nickname ?? v.contract ?? "sem contrato"}</span>
      {!compact && <small>{v.technician}{v.partnerName ? ` · ${v.partnerName}` : ""}</small>}
      {late && <i className="late-dot" aria-label="Atrasada" />}
    </button>
  );
}

/** Agenda de visitas de instalação: dia, semana e mês, filtro por técnico e arrastar para reagendar. */
export function AgendaPage({ user, onOpenInstallation }: { user: User; onOpenInstallation: (id: string) => void }) {
  const say = useToast();
  const isAdmin = user.role === "admin_speed";
  const [view, setView] = useState<View>("semana");
  const [anchor, setAnchor] = useState(() => new Date());
  const [tech, setTech] = useState("");
  const [visits, setVisits] = useState<AgendaVisit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const now = useMemo(() => new Date(), [visits]);

  const { from, to, days } = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const load = useCallback(() => {
    api.agenda(from.toISOString(), to.toISOString()).then((r) => setVisits(r.visits)).catch((e) => { say(errMsg(e, "Falha ao carregar a agenda."), "bad"); setVisits([]); });
  }, [from, to, say]);
  useEffect(() => {
    setVisits(null);
    load();
  }, [load]);

  const technicians = useMemo(() => [...new Set((visits ?? []).map((v) => v.technician).filter((t): t is string => !!t))].sort(), [visits]);
  const shown = useMemo(() => (visits ?? []).filter((v) => !tech || v.technician === tech), [visits, tech]);
  const byDay = useMemo(() => {
    const m = new Map<string, AgendaVisit[]>();
    for (const v of shown) {
      const k = key(new Date(v.visitAt));
      m.set(k, [...(m.get(k) ?? []), v]);
    }
    return m;
  }, [shown]);

  const step = (dir: -1 | 1) => {
    if (view === "mes") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else setAnchor(addDays(anchor, dir * (view === "semana" ? 7 : 1)));
  };

  /** Solta o card num dia (e, nas visões de dia e semana, num período). Sem período, mantém o da visita. */
  async function drop(e: DragEvent, day: Date, period?: VisitPeriod) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const v = (visits ?? []).find((x) => x.id === id);
    if (!v || isAdmin) return;
    const next = period ?? v.visitPeriod;
    if (sameDay(new Date(v.visitAt), day) && v.visitPeriod === next) return;
    try {
      await api.reschedule(id, { visitAt: visitInstant(toDateInput(day), next), visitPeriod: next });
      say(`Visita reagendada para ${day.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}, ${periodLabel(next).toLowerCase()}`);
      load();
    } catch (err) {
      say(errMsg(err, "Falha ao reagendar."), "bad");
    }
  }

  const sel = shown.find((v) => v.id === selected) ?? null;
  const canDrag = (v: AgendaVisit) => !isAdmin && v.visitStatus !== "concluida" && !v.osClosedAt;

  const card = (v: AgendaVisit, compact: boolean) => (
    <VisitCard key={v.id} v={v} now={now} compact={compact} draggable={canDrag(v)} onOpen={() => setSelected(v.id)} onDragStart={(e) => { e.dataTransfer.setData("text/plain", v.id); e.dataTransfer.effectAllowed = "move"; }} />
  );

  const cell = (day: Date, compact: boolean, outside = false) => {
    const items = byDay.get(key(day)) ?? [];
    const k = key(day);
    const max = compact ? 3 : 99;
    const head = view !== "dia" && (
      <div className="ag-dh">
        {view === "semana" && <span>{WEEKDAYS[(day.getDay() + 6) % 7]}</span>}
        <b>{day.getDate()}</b>
      </div>
    );
    const cls = `ag-day ${sameDay(day, now) ? "today" : ""} ${outside ? "out" : ""}`;
    // Dia e semana: duas faixas, manhã e tarde, cada uma com o seu alvo de soltar.
    if (!compact) {
      return (
        <div key={k} className={cls}>
          {head}
          {PERIODS.map((p) => {
            const bk = `${k}-${p.id}`;
            const list = items.filter((v) => v.visitPeriod === p.id);
            return (
              <div
                key={p.id}
                className={`ag-band ${dragOver === bk ? "over" : ""}`}
                onDragOver={(e) => { if (!isAdmin) { e.preventDefault(); setDragOver(bk); } }}
                onDragLeave={() => setDragOver((cur) => (cur === bk ? null : cur))}
                onDrop={(e) => void drop(e, day, p.id)}
              >
                <span className="ag-bl">{p.label}</span>
                {list.map((v) => card(v, false))}
                {view === "dia" && list.length === 0 && <p className="empty">Nenhuma visita.</p>}
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div
        key={k}
        className={`${cls} ${dragOver === k ? "over" : ""}`}
        onDragOver={(e) => { if (!isAdmin) { e.preventDefault(); setDragOver(k); } }}
        onDragLeave={() => setDragOver((cur) => (cur === k ? null : cur))}
        onDrop={(e) => void drop(e, day)}
      >
        {head}
        {items.slice(0, max).map((v) => card(v, true))}
        {items.length > max && <button type="button" className="linkbtn ag-more" onClick={() => { setAnchor(day); setView("dia"); }}>+{items.length - max} mais</button>}
      </div>
    );
  };

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Agenda</h1>
          <p>{isAdmin ? "Visitas de instalação de todos os parceiros." : "Visitas de instalação. Arraste um card para outro dia ou período para reagendar."}</p>
        </div>
      </div>

      <div className="ag-bar">
        <div className="ag-nav">
          <button className="btn sec sm" onClick={() => step(-1)} aria-label="Anterior">‹</button>
          <button className="btn sec sm" onClick={() => setAnchor(new Date())}>Hoje</button>
          <button className="btn sec sm" onClick={() => step(1)} aria-label="Próximo">›</button>
          <b className="ag-title">{cap(titleFor(view, anchor, days))}</b>
        </div>
        <div className="ag-ctrl">
          <select value={tech} onChange={(e) => setTech(e.target.value)} aria-label="Filtrar por técnico">
            <option value="">Todos os técnicos</option>
            {technicians.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="seg" role="tablist" aria-label="Visão">
            {([["dia", "Dia"], ["semana", "Semana"], ["mes", "Mês"]] as [View, string][]).map(([v, l]) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="card ag-wrap">
        {visits === null ? (
          <p className="empty">Carregando…</p>
        ) : (
          <div className={`ag-grid v-${view}`}>
            {view === "mes" && WEEKDAYS.map((w) => <div key={w} className="ag-wd">{w}</div>)}
            {days.map((d) => cell(d, view === "mes", view === "mes" && d.getMonth() !== anchor.getMonth()))}
          </div>
        )}
      </div>

      {sel && (
        <div className="card">
          <div className="ch">
            <div>
              <h3>{sel.nickname ?? (sel.contract ? `Contrato ${sel.contract}` : "Sem contrato ainda")}</h3>
              <small>{new Date(sel.visitAt).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })} · {periodLabel(sel.visitPeriod)}</small>
            </div>
            <span className={`badge ${STATUS[sel.visitStatus].tone}`}>{STATUS[sel.visitStatus].label}</span>
          </div>
          <div className="summary">
            <div className="g3 os-sum">
              <div><small>Endereço</small><span>{sel.address}</span></div>
              <div><small>CTO · plano</small><span><span className="mono">{sel.ctoName}</span> · {sel.planName ?? "—"}</span></div>
              <div><small>Técnico</small><span>{sel.technician ?? "—"}{sel.partnerName ? ` · ${sel.partnerName}` : ""}</span></div>
            </div>
            {isLate(sel, now) && <p className="note">Esta visita passou do dia sem ser concluída. Reagende ou conclua a O.S.</p>}
            <div className="acts2">
              <button className="btn sm" onClick={() => onOpenInstallation(sel.id)}>Abrir instalação</button>
              <button className="btn sec sm" onClick={() => setSelected(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
