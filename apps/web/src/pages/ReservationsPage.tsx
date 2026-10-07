import { useEffect, useState } from "react";
import { api, type Partner, type Reservation, type User } from "../api";
import { useToast } from "../ui/Toast";

const STATUS: Record<Reservation["status"], { label: string; tone: string }> = {
  ativa: { label: "Ativa", tone: "b-data" },
  convertida: { label: "Virou contrato", tone: "b-ok" },
  cancelada: { label: "Cancelada", tone: "b-mute" },
  expirada: { label: "Expirada", tone: "b-mute" },
};

const RC = 2 * Math.PI * 36;
const HOUR = 3600_000;

const pad = (n: number) => String(n).padStart(2, "0");

function fmtLeft(ms: number): string {
  if (ms <= 0) return "0 min";
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  const h = Math.floor(ms / HOUR);
  return ms < 10 * HOUR ? `${h}h${pad(Math.floor((ms % HOUR) / 60_000))}` : `${h}h`;
}

function ringState(ms: number): "" | "warn" | "bad" {
  return ms < 3 * HOUR ? "bad" : ms < 12 * HOUR ? "warn" : "";
}

function Ring({ left, total }: { left: number; total: number }) {
  // Começa vazio e enche depois do primeiro desenho, para o anel "entrar" animado.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const frac = Math.min(1, Math.max(0, left / total));
  return (
    <div className={`ring ${ringState(left)}`}>
      <svg viewBox="0 0 84 84" aria-hidden="true">
        <circle className="bg" cx="42" cy="42" r="36" />
        <circle className="fg" cx="42" cy="42" r="36" strokeDasharray={RC} strokeDashoffset={drawn ? RC * (1 - frac) : RC} />
      </svg>
      <div>
        <b>{fmtLeft(left)}</b>
        <small>restantes</small>
      </div>
    </div>
  );
}

export function ReservationsPage({
  user,
  partner,
  items,
  reload,
}: {
  user: User;
  partner: Partner | null;
  items: Reservation[] | null;
  reload: () => Promise<void>;
}) {
  const say = useToast();
  const isAdmin = user.role === "admin_speed";
  const [now, setNow] = useState(Date.now());
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function cancel(r: Reservation) {
    if (isAdmin && !reason.trim()) return;
    setBusy(true);
    try {
      await api.cancel(r.id, isAdmin ? reason.trim() : undefined);
      say(`Porta ${r.port} da ${r.ctoName} liberada`);
      setAsking(null);
      setReason("");
      await reload();
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao cancelar.", "bad");
    } finally {
      setBusy(false);
    }
  }

  if (items === null) return <main className="page"><p className="muted">Carregando…</p></main>;

  const active = items.filter((r) => r.status === "ativa");
  const past = items.filter((r) => r.status !== "ativa");
  const max = partner?.maxActiveReservations ?? null;

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Reservas</h1>
          <p>Cada porta fica guardada por 48 horas. O anel mostra quanto tempo falta.</p>
        </div>
      </div>

      {max !== null && (
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="cap">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <b style={{ fontWeight: 500 }}>Reservas abertas</b>
              <span className="mono">{active.length} de {max}</span>
            </div>
            <div className="tr" aria-hidden="true">
              {max <= 20 ? (
                Array.from({ length: max }, (_, i) => <i key={i} className={i < active.length ? "on" : ""} />)
              ) : (
                <span className="fill" style={{ width: `${Math.min(100, (active.length / max) * 100)}%` }} />
              )}
            </div>
            <small>Seu contrato permite até {max} reservas ao mesmo tempo.</small>
          </div>
        </div>
      )}

      {active.length === 0 ? (
        <p className="note">Nenhuma reserva aberta. Comece por uma nova venda.</p>
      ) : (
        <div className="rgrid">
          {active.map((r) => {
            const expires = r.expiresAt ? new Date(r.expiresAt).getTime() : now;
            const total = r.expiresAt ? expires - new Date(r.createdAt).getTime() : 48 * HOUR;
            return (
              <div className="card rcard" key={r.id}>
                <Ring left={expires - now} total={total} />
                <div>
                  <h4>{r.ctoName} · porta {pad(r.port)}</h4>
                  <p>{r.address}</p>
                  {asking !== r.id && (
                    <div className="acts2">
                      <button className="btn sec sm" onClick={() => { setAsking(r.id); setReason(""); }}>Cancelar reserva</button>
                    </div>
                  )}
                </div>
                {asking === r.id && (
                  <div className="ask">
                    <span>{isAdmin ? "Informe o motivo. Ele fica registrado na auditoria." : "A porta volta a ficar livre na hora."}</span>
                    {isAdmin && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo do cancelamento" aria-label="Motivo do cancelamento" />}
                    <div className="acts2">
                      <button className="btn sm" disabled={busy || (isAdmin && !reason.trim())} onClick={() => cancel(r)}>
                        {busy ? "Cancelando…" : "Sim, liberar a porta"}
                      </button>
                      <button className="btn sec sm" onClick={() => setAsking(null)}>Voltar</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {past.length > 0 && (
        <div className="card">
          <div className="ch"><h3>Histórico</h3><small>últimas {past.length}</small></div>
          <table className="hist">
            <thead>
              <tr><th>CTO / porta</th><th>Endereço</th><th>Situação</th></tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id}>
                  <td>{r.ctoName} · {pad(r.port)}</td>
                  <td>{r.address}</td>
                  <td>
                    <span className={`badge ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                    {r.cancelReason && <small className="muted"> {r.cancelReason}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
