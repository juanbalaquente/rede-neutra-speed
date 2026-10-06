import { useCallback, useEffect, useState } from "react";
import { api, type Reservation, type User } from "../api";

const STATUS_LABEL: Record<Reservation["status"], string> = {
  ativa: "Ativa",
  convertida: "Virou contrato",
  cancelada: "Cancelada",
  expirada: "Expirada",
};

function timeLeft(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "expirando";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return `${h}h ${m}min restantes`;
}

export function ReservationsPage({ user }: { user: User }) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    api.reservations().then((r) => setItems(r.reservations)).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function cancel(r: Reservation) {
    const isAdmin = user.role === "admin_speed";
    const reason = isAdmin ? prompt("Motivo do cancelamento (obrigatório):") : null;
    if (isAdmin && !reason?.trim()) return;
    if (!isAdmin && !confirm(`Cancelar a reserva da porta ${r.port} da ${r.ctoName}? A porta volta a ficar livre.`)) return;
    try {
      await api.cancel(r.id, reason ?? undefined);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao cancelar.");
    }
  }

  return (
    <section>
      <h1>Reservas</h1>
      {error && <p className="error">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">Nenhuma reserva ainda.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>CTO / porta</th>
              <th>Endereço</th>
              <th>Situação</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const left = r.status === "ativa" ? timeLeft(r.expiresAt, now) : "";
              const soon = r.status === "ativa" && r.expiresAt && new Date(r.expiresAt).getTime() - now < 6 * 3600_000;
              return (
                <tr key={r.id}>
                  <td>
                    <strong>{r.ctoName}</strong> · porta {r.port}
                  </td>
                  <td>{r.address}</td>
                  <td>
                    <span className={`status ${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    {left && <small className={soon ? "warn" : "muted"}> {left}</small>}
                  </td>
                  <td>
                    {r.status === "ativa" && (
                      <button className="link" onClick={() => cancel(r)}>
                        Cancelar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
