import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CapacityRequest } from "../api";
import { useToast } from "./Toast";

const STATUS: Record<CapacityRequest["status"], { label: string; tone: string }> = {
  pendente: { label: "Aguardando a Speed", tone: "b-warn" },
  confirmado: { label: "Confirmado", tone: "b-ok" },
  recusado: { label: "Recusado", tone: "b-mute" },
  cancelado: { label: "Cancelado", tone: "b-mute" },
};

/** Pedidos de vaga do parceiro: os que esperam a Speed e as decisões dos últimos dias. */
export function CapacityRequestsList({ onChanged }: { onChanged: () => void }) {
  const say = useToast();
  const [items, setItems] = useState<CapacityRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.capacityRequests().then((r) => setItems(r.requests)).catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function cancel(r: CapacityRequest) {
    setBusy(r.id);
    try {
      await api.cancelCapacityRequest(r.id);
      say(`Pedido na ${r.ctoName} cancelado`);
      load();
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao cancelar.", "bad");
    } finally {
      setBusy(null);
    }
  }

  // Pedido cancelado não interessa; decisões antigas saem da vista depois de 7 dias.
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const shown = (items ?? []).filter((r) => r.status === "pendente" || (r.status !== "cancelado" && new Date(r.decidedAt ?? r.createdAt).getTime() > weekAgo));
  // Uma confirmação nova cria reserva: avisa a tela para recarregar, uma vez por mudança.
  const confirmed = shown.filter((r) => r.status === "confirmado").length;
  const seen = useRef<number | null>(null);
  const notify = useRef(onChanged);
  notify.current = onChanged;
  useEffect(() => {
    if (items === null) return;
    if (seen.current !== null && confirmed > seen.current) notify.current();
    seen.current = confirmed;
  }, [items, confirmed]);

  if (shown.length === 0) return null;
  return (
    <div className="card">
      <div className="ch"><h3>Pedidos de vaga</h3><small>CTOs sem vaga livre: a Speed confirma ou estende a rede</small></div>
      <table className="hist">
        <thead>
          <tr><th>CTO</th><th>Endereço</th><th>Situação</th><th /></tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.ctoName}</td>
              <td style={{ fontFamily: "var(--font)" }}>{r.address}</td>
              <td style={{ fontFamily: "var(--font)" }}>
                <span className={`badge ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                {r.status === "recusado" && r.decisionNote && <div className="muted" style={{ fontSize: 12 }}>{r.decisionNote}</div>}
                {r.status === "confirmado" && <div className="muted" style={{ fontSize: 12 }}>A vaga virou uma reserva de 48 horas.</div>}
              </td>
              <td>
                {r.status === "pendente" && (
                  <button className="btn sec sm" disabled={busy === r.id} onClick={() => void cancel(r)}>Cancelar</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
