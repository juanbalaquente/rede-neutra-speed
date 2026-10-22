import { useCallback, useEffect, useState } from "react";
import { api, type CapacityRequest } from "../api";
import { motivoLabel } from "../motivos";
import { RouteLink } from "../ui/RouteLink";
import { useToast } from "../ui/Toast";

const BLOCKED_LABEL: Record<CapacityRequest["blockedReason"], string> = {
  sem_vaga_livre: "Sem vaga livre",
  limite_ocupacao: "Limite de ocupação do parceiro",
  conferir: "Dado a conferir",
};

const DECIDED_LABEL: Record<CapacityRequest["status"], string> = {
  pendente: "Pendente",
  confirmado: "Confirmado",
  recusado: "Recusado",
  cancelado: "Cancelado pelo parceiro",
};

/** Administrador Speed: confirma (a Speed garante a vaga, estendendo a rede se for preciso) ou recusa. */
export function CapacityRequestsPage({ onChanged }: { onChanged: () => void }) {
  const say = useToast();
  const [items, setItems] = useState<CapacityRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.capacityRequests().then((r) => setItems(r.requests)).catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar."));
  }, []);
  useEffect(load, [load]);

  async function decide(r: CapacityRequest, decision: "confirmar" | "recusar") {
    setBusy(r.id);
    try {
      await api.decideCapacityRequest(r.id, decision, decision === "recusar" ? note.trim() : undefined);
      say(decision === "confirmar" ? `Vaga confirmada na ${r.ctoName}: reserva de 48 horas criada` : "Pedido recusado");
      setRefusing(null);
      setNote("");
      load();
      onChanged();
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao decidir.", "bad");
    } finally {
      setBusy(null);
    }
  }

  const pending = (items ?? []).filter((r) => r.status === "pendente");
  const decided = (items ?? []).filter((r) => r.status !== "pendente").slice(0, 30);

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Pedidos de vaga</h1>
          <p>Vendas em CTO cheia ou em conferência. Ao confirmar, a Speed garante a vaga (estendendo a rede, se preciso) e nasce uma reserva de 48 horas para o parceiro.</p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!error && items === null && <p className="muted">Carregando…</p>}
      {items && pending.length === 0 && <p className="note">Nenhum pedido esperando decisão.</p>}

      {pending.length > 0 && (
        <div className="card">
          <div className="ch"><h3>{pending.length} esperando decisão</h3><small>do mais antigo para o mais novo</small></div>
          <table className="hist">
            <thead>
              <tr><th>Parceiro</th><th>CTO</th><th>Endereço</th><th>Situação da CTO</th><th /></tr>
            </thead>
            <tbody>
              {[...pending].reverse().map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: "var(--font)" }}>
                    {r.partnerName}
                    <div className="muted" style={{ fontSize: 12 }}>{new Date(r.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                  </td>
                  <td>
                    {r.ctoName}
                    <div className="muted" style={{ fontSize: 12 }}>{r.regiao ?? "sem sigla"}{r.totalVagas ? ` · ${r.totalVagas} saídas` : ""}</div>
                  </td>
                  <td style={{ fontFamily: "var(--font)" }}>
                    {r.address}
                    {r.ctoLat !== null && r.ctoLng !== null && <div><RouteLink to={{ lat: r.ctoLat, lng: r.ctoLng }} label="Rota até a CTO" /></div>}
                  </td>
                  <td style={{ fontFamily: "var(--font)" }}>
                    {BLOCKED_LABEL[r.blockedReason]}
                    {r.motivos.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.motivos.map(motivoLabel).join("; ")}</div>}
                  </td>
                  <td>
                    {refusing === r.id ? (
                      <div style={{ display: "grid", gap: 6, minWidth: 200 }}>
                        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motivo da recusa (o parceiro vai ler)" aria-label="Motivo da recusa" maxLength={500} />
                        {note.trim().length < 10 && <small className="muted">Escreva o motivo com pelo menos 10 caracteres.</small>}
                        <div className="acts2">
                          <button className="btn sm" disabled={busy === r.id || note.trim().length < 10} onClick={() => void decide(r, "recusar")}>Recusar</button>
                          <button className="btn sec sm" onClick={() => { setRefusing(null); setNote(""); }}>Voltar</button>
                        </div>
                      </div>
                    ) : (
                      <div className="acts2">
                        <button className="btn sm" disabled={busy === r.id} onClick={() => void decide(r, "confirmar")}>Confirmar vaga</button>
                        <button className="btn sec sm" onClick={() => { setRefusing(r.id); setNote(""); }}>Recusar</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {decided.length > 0 && (
        <div className="card">
          <div className="ch"><h3>Decididos</h3><small>últimos {decided.length}</small></div>
          <table className="hist">
            <thead>
              <tr><th>Parceiro</th><th>CTO</th><th>Endereço</th><th>Resultado</th></tr>
            </thead>
            <tbody>
              {decided.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: "var(--font)" }}>{r.partnerName}</td>
                  <td>{r.ctoName}</td>
                  <td style={{ fontFamily: "var(--font)" }}>{r.address}</td>
                  <td style={{ fontFamily: "var(--font)" }}>
                    {DECIDED_LABEL[r.status]}
                    {r.decisionNote && <div className="muted" style={{ fontSize: 12 }}>{r.decisionNote}</div>}
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
