import { useCallback, useEffect, useState } from "react";
import { api, type Installation, type User } from "../api";
import { ticketApi, type Ticket, type TicketDetail, type TicketState, type TicketType } from "../ticketsApi";
import { useDraft } from "../ui/useDraft";
import { useToast } from "../ui/Toast";

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);
const fmtDate = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const TICKET_TYPE_OPTIONS: { value: Exclude<TicketType, "trava_sinal">; label: string; hint: string }[] = [
  { value: "cto_com_problema", label: "CTO com problema", hint: "Caixa aberta, fibra solta, sem etiqueta ou danificada." },
  { value: "porta_off", label: "Porta sem sinal", hint: "A porta de um cliente ativo ficou OFF." },
  { value: "conferencia_porta", label: "Conferência de porta", hint: "A porta não bate com o que está cadastrado." },
  { value: "sinal_fora_padrao_cto", label: "Sinal fora do padrão na CTO", hint: "A CTO entrega um sinal pior que o esperado." },
  { value: "rompimento_regional", label: "Rompimento na região", hint: "Vários clientes da mesma região sem acesso." },
];

export const TICKET_LABEL: Record<TicketType, string> = {
  cto_com_problema: "CTO com problema",
  porta_off: "Porta sem sinal",
  conferencia_porta: "Conferência de porta",
  sinal_fora_padrao_cto: "Sinal fora do padrão na CTO",
  rompimento_regional: "Rompimento na região",
  trava_sinal: "Trava de sinal",
};

const STATE: Record<TicketState, { label: string; tone: string }> = {
  recebido: { label: "Guardado, não entregue", tone: "b-warn" },
  aberto: { label: "Aberto", tone: "b-data" },
  em_atendimento: { label: "Em atendimento", tone: "b-data" },
  aguardando_parceiro: { label: "Aguardando você", tone: "b-warn" },
  resolvido: { label: "Resolvido", tone: "b-ok" },
  cancelado: { label: "Cancelado", tone: "b-mute" },
};

const isOpen = (t: Pick<Ticket, "state">) => t.state !== "resolvido" && t.state !== "cancelado";

/** "vence em 5 h", "atrasado há 2 dias". */
function dueText(t: Ticket): string {
  const diff = new Date(t.dueAt).getTime() - Date.now();
  const abs = Math.abs(diff);
  const text = abs >= 48 * 3600_000 ? `${Math.round(abs / (24 * 3600_000))} dias` : abs >= 3600_000 ? `${Math.round(abs / 3600_000)} h` : `${Math.max(1, Math.round(abs / 60_000))} min`;
  return diff < 0 ? `atrasado há ${text}` : `vence em ${text}`;
}

const inputStyle = { border: "1px solid var(--line2)", borderRadius: 9, padding: "9px 11px", background: "var(--surf)", color: "var(--ink)" } as const;

function NewTicket({ onCreated, onCancel }: { onCreated: (t: TicketDetail) => void; onCancel: () => void }) {
  const say = useToast();
  const [form, set, clear] = useDraft("chamado-novo", { type: "cto_com_problema", description: "", reservationId: "", cto: "", signal: "" });
  const [clients, setClients] = useState<Installation[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.installations().then((r) => setClients(r.installations.filter((i) => i.customerStatus !== "cancelado"))).catch(() => setClients([]));
  }, []);
  const signal = form.signal.trim() === "" ? null : Number(form.signal.replace(",", "."));
  const signalOk = signal === null || (Number.isFinite(signal) && signal <= 0 && signal >= -40);
  const valid = form.description.trim().length >= 5 && signalOk;
  const hint = TICKET_TYPE_OPTIONS.find((o) => o.value === form.type)?.hint;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { ticket } = await ticketApi.create({
        type: form.type as TicketType,
        description: form.description.trim(),
        reservationId: form.reservationId || null,
        ctoId: !form.reservationId && form.cto.trim() ? form.cto.trim() : null,
        signalDbm: signal,
      });
      clear();
      say(ticket.undelivered ? "Chamado guardado. A entrega à Infra será refeita." : "Chamado aberto");
      onCreated(ticket);
    } catch (err) {
      say(errMsg(err, "Falha ao abrir o chamado."), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="ch"><h3>Novo chamado para a Infra</h3></div>
      <div className="summary" style={{ display: "grid", gap: 12 }}>
        <label className="fld">
          <span>Assunto</span>
          <select value={form.type} onChange={(e) => set({ type: e.target.value })}>
            {TICKET_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {hint && <small>{hint}</small>}
        </label>
        <label className="fld">
          <span>Cliente (opcional)</span>
          <select value={form.reservationId} onChange={(e) => set({ reservationId: e.target.value })}>
            <option value="">Nenhum, informo a CTO</option>
            {clients.map((i) => <option key={i.id} value={i.id}>{i.contract ?? "sem contrato"}{i.nickname ? ` · ${i.nickname}` : ""} · {i.ctoName}</option>)}
          </select>
          <small>Com o cliente escolhido, a CTO e o login seguem junto no chamado.</small>
        </label>
        {!form.reservationId && (
          <label className="fld">
            <span>CTO (opcional)</span>
            <input value={form.cto} onChange={(e) => set({ cto: e.target.value })} maxLength={120} />
          </label>
        )}
        <label className="fld" style={{ maxWidth: 240 }}>
          <span>Sinal medido (dBm, opcional)</span>
          <input value={form.signal} onChange={(e) => set({ signal: e.target.value })} inputMode="decimal" placeholder="-21,5" />
          {!signalOk && <small className="error">Entre -40 e 0.</small>}
        </label>
        <label className="fld">
          <span>O que está acontecendo</span>
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} maxLength={2000} style={{ ...inputStyle, font: "inherit", resize: "vertical" }} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" disabled={!valid || busy}>{busy ? "Enviando…" : "Abrir chamado"}</button>
          <button type="button" className="btn sec" onClick={onCancel}>Cancelar</button>
        </div>
      </div>
    </form>
  );
}

function Detail({ id, user, onChanged }: { id: string; user: User; onChanged: () => void }) {
  const say = useToast();
  const [t, setT] = useState<TicketDetail | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const isAdmin = user.role === "admin_speed";

  useEffect(() => {
    let alive = true;
    ticketApi.get(id).then((r) => alive && setT(r.ticket)).catch((e) => say(errMsg(e, "Falha ao carregar o chamado."), "bad"));
    return () => { alive = false; };
  }, [id, say]);

  async function act(fn: () => Promise<{ ticket: TicketDetail }>, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      setT((await fn()).ticket);
      say(ok);
      onChanged();
      return true;
    } catch (e) {
      say(errMsg(e, "Não foi possível concluir."), "bad");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!t) return <div className="card"><p className="empty">Carregando…</p></div>;
  const st = STATE[t.state];
  return (
    <div className="card">
      <div className="ch">
        <h3>{t.typeLabel}{t.origin === "sistema" ? " · automático" : ""}</h3>
        <span className={`badge ${st.tone}`}>{st.label}</span>
      </div>
      <div className="summary" style={{ display: "grid", gap: 8 }}>
        {isAdmin && t.partnerName && <div><b>Parceiro:</b> {t.partnerName}</div>}
        {t.ctoName && <div><b>CTO:</b> <span className="mono">{t.ctoName}</span></div>}
        {t.login && <div><b>Login:</b> <span className="mono">{t.login}</span></div>}
        {t.signalDbm !== null && <div><b>Sinal medido:</b> {String(t.signalDbm).replace(".", ",")} dBm</div>}
        <div>
          <b>Prazo:</b> {t.slaHours} h · {isOpen(t) ? <span className={t.late ? "error" : ""}>{dueText(t)}</span> : t.resolvedAt ? `resolvido em ${fmtDate(t.resolvedAt)}` : "encerrado"}
        </div>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{t.description}</p>
        {t.undelivered && (
          <div className="banner warn" role="status">
            O chamado está guardado, mas ainda não chegou à Infra.
            {!isAdmin && <> <button className="btn sm" disabled={busy} onClick={() => void act(() => ticketApi.retry(t.id), "Reenviado")}>Reenviar agora</button></>}
          </div>
        )}
      </div>
      <div className="summary" style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)" }}>
        {t.messages.map((m) => (
          <div key={m.id} style={{ display: "grid", gap: 2 }}>
            <small className="muted">{m.author === "infra" ? "Infra" : m.author === "parceiro" ? "Parceiro" : "Sistema"} · {fmtDate(m.createdAt)}</small>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
          </div>
        ))}
        {!isAdmin && isOpen(t) && !t.undelivered && (
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => ticketApi.message(t.id, text.trim()), "Mensagem enviada").then((ok) => ok && setText(""));
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Responder à Infra" maxLength={2000} style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
            <button className="btn sm" disabled={busy || text.trim().length < 2}>Enviar</button>
          </form>
        )}
      </div>
    </div>
  );
}

type Filter = "abertos" | "atrasados" | "resolvidos" | "todos";

export function TicketsPage({ user, initialId }: { user: User; initialId?: string | null }) {
  const [list, setList] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("abertos");
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [creating, setCreating] = useState(false);
  const isAdmin = user.role === "admin_speed";

  const load = useCallback(() => {
    ticketApi.list().then((r) => { setList(r.tickets); setError(null); }).catch((e) => setError(errMsg(e, "Falha ao carregar.")));
  }, []);
  useEffect(load, [load]);

  const shown = (list ?? []).filter((t) => (filter === "abertos" ? isOpen(t) : filter === "atrasados" ? t.late : filter === "resolvidos" ? !isOpen(t) : true));
  const FILTERS: [Filter, string][] = [["abertos", "Abertos"], ["atrasados", "Atrasados"], ["resolvidos", "Resolvidos"], ["todos", "Todos"]];

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Chamados</h1>
          <p>{isAdmin ? "Os chamados de infraestrutura de todos os parceiros, com o prazo de cada tipo." : "Fale com a Infra da Speed sobre CTO, porta e sinal. O prazo de resposta aparece em cada chamado."}</p>
        </div>
        {!isAdmin && !creating && <button className="btn" onClick={() => { setCreating(true); setSelected(null); }}>Novo chamado</button>}
      </div>

      {creating && <NewTicket onCancel={() => setCreating(false)} onCreated={(t) => { setCreating(false); setSelected(t.id); load(); }} />}

      <div className="seg" role="tablist" aria-label="Filtro">
        {FILTERS.map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{label}</button>
        ))}
      </div>

      <div className="card">
        {error ? (
          <p className="error">{error}</p>
        ) : list === null ? (
          <p className="empty">Carregando…</p>
        ) : shown.length === 0 ? (
          <p className="empty">Nenhum chamado neste filtro.</p>
        ) : (
          <table className="hist inst">
            <thead>
              <tr>
                <th>Assunto</th>
                {isAdmin && <th>Parceiro</th>}
                <th>CTO</th>
                <th>Prazo</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className={t.id === selected ? "on" : ""}>
                  <td style={{ fontFamily: "var(--font)" }}>
                    <button className="rowbtn" onClick={() => { setSelected(t.id); setCreating(false); }}>{t.typeLabel}{t.origin === "sistema" ? " · automático" : ""}</button>
                    <div className="muted" style={{ fontSize: 12 }}>aberto em {fmtDate(t.createdAt)}</div>
                  </td>
                  {isAdmin && <td style={{ fontFamily: "var(--font)" }}>{t.partnerName}</td>}
                  <td className="mono">{t.ctoName ?? "—"}</td>
                  <td className={t.late ? "error" : ""}>{isOpen(t) ? dueText(t) : "—"}</td>
                  <td><span className={`badge ${STATE[t.state].tone}`}>{STATE[t.state].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && <Detail key={selected} id={selected} user={user} onChanged={load} />}
    </main>
  );
}
