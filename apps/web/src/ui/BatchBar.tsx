import { useState } from "react";
import { request, type Installation } from "../api";
import { useToast } from "./Toast";

type BatchType = "bloqueio" | "desbloqueio" | "reinicio";
interface BatchResult { reservationId: string; ok: boolean; state: string | null; error: string | null }

const LABEL: Record<BatchType, { button: string; verb: string; warn: string }> = {
  bloqueio: { button: "Bloquear", verb: "bloquear", warn: "O acesso dos clientes é suspenso. Eles continuam ocupando a porta e sendo faturados." },
  desbloqueio: { button: "Desbloquear", verb: "desbloquear", warn: "O acesso dos clientes volta." },
  reinicio: { button: "Reiniciar ONU", verb: "reiniciar a ONU de", warn: "As ONUs reiniciam e os clientes ficam sem internet por alguns minutos." },
};

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

/**
 * Barra de ações em lote da lista de Instalações: bloquear, desbloquear ou reiniciar vários clientes de uma vez.
 * Cancelar não entra aqui de propósito (encerra contrato e devolve a vaga): é cliente a cliente.
 */
export function BatchBar({ selected, all, onClear, onDone }: { selected: string[]; all: Installation[]; onClear: () => void; onDone: () => void }) {
  const say = useToast();
  const [asking, setAsking] = useState<BatchType | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);

  const label = (id: string) => {
    const i = all.find((x) => x.id === id);
    return i ? `${i.contract ?? "sem contrato"}${i.nickname ? ` · ${i.nickname}` : ""}` : id;
  };

  async function run() {
    if (!asking) return;
    setBusy(true);
    try {
      const r = await request<{ results: BatchResult[]; feitos: number; pulados: number }>("POST", "/operations/batch", { type: asking, reservationIds: selected, reason: reason.trim() || null });
      setResults(r.results);
      say(r.pulados ? `${r.feitos} enviado(s), ${r.pulados} pulado(s)` : `${r.feitos} enviado(s)`);
      setAsking(null);
      setReason("");
      onDone();
    } catch (e) {
      say(errMsg(e, "Falha ao enviar o lote."), "bad");
    } finally {
      setBusy(false);
    }
  }

  if (selected.length === 0 && !results) return null;
  const skipped = results?.filter((r) => !r.ok) ?? [];

  return (
    <div className="card" style={{ position: "sticky", top: 8, zIndex: 5 }}>
      <div className="summary" style={{ display: "grid", gap: 10 }}>
        {selected.length > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <b style={{ fontWeight: 500 }}>{selected.length} cliente{selected.length > 1 ? "s" : ""} selecionado{selected.length > 1 ? "s" : ""}</b>
            {(Object.keys(LABEL) as BatchType[]).map((t) => (
              <button key={t} className="btn sec sm" disabled={busy} onClick={() => { setAsking(t); setResults(null); }}>{LABEL[t].button}</button>
            ))}
            <button className="linkbtn" onClick={onClear}>Limpar seleção</button>
          </div>
        )}
        {asking && (
          <div className="banner" style={{ margin: 0, display: "grid", gap: 8 }} role="alertdialog" aria-label="Confirmar ação em lote">
            <span>Vou {LABEL[asking].verb} <b>{selected.length}</b> cliente{selected.length > 1 ? "s" : ""}. {LABEL[asking].warn}</span>
            {asking === "bloqueio" && (
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (opcional)" maxLength={300} style={{ border: "1px solid var(--line2)", borderRadius: 9, padding: "8px 10px", background: "var(--surf)", color: "var(--ink)" }} />
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn sm" disabled={busy} onClick={() => void run()}>{busy ? "Enviando…" : "Confirmar"}</button>
              <button className="btn sec sm" disabled={busy} onClick={() => setAsking(null)}>Voltar</button>
            </div>
          </div>
        )}
        {results && (
          <div style={{ display: "grid", gap: 4 }}>
            <b style={{ fontWeight: 500 }}>Resultado: {results.length - skipped.length} enviado(s){skipped.length ? `, ${skipped.length} pulado(s)` : ""}</b>
            {skipped.map((r) => (
              <small key={r.reservationId} style={{ color: "var(--warn)" }}>{label(r.reservationId)}: {r.error}</small>
            ))}
            <div><button className="linkbtn" onClick={() => setResults(null)}>Fechar</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
