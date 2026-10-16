import { useCallback, useEffect, useState } from "react";
import { request, type OperationType } from "../api";
import { useToast } from "./Toast";

interface Pending {
  id: string;
  type: OperationType;
  login: string;
  reason: string | null;
  partnerName: string;
  contract: string | null;
  nickname: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<OperationType, string> = { bloqueio: "Bloqueio", desbloqueio: "Desbloqueio", reinicio: "Reinício da ONU", cancelamento: "Cancelamento" };
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

/**
 * A Speed pode exigir a própria aprovação para certos tipos de operação do cliente final (o planejamento prevê que o
 * administrador "aprova ou recusa operações"). Sem nada marcado, tudo segue direto. A decisão fica na auditoria.
 */
export function ApprovalsCard() {
  const say = useToast();
  const [types, setTypes] = useState<OperationType[] | null>(null);
  const [all, setAll] = useState<OperationType[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    request<{ types: OperationType[]; all: OperationType[] }>("GET", "/admin/settings/aprovacoes").then((r) => { setTypes(r.types); setAll(r.all); }).catch(() => setTypes(null));
    request<{ operations: Pending[] }>("GET", "/admin/operations/pending").then((r) => setPending(r.operations)).catch(() => setPending([]));
  }, []);
  useEffect(load, [load]);

  if (types === null) return null;

  async function toggle(t: OperationType, on: boolean) {
    const next = on ? [...types!, t] : types!.filter((x) => x !== t);
    try {
      const r = await request<{ types: OperationType[] }>("PUT", "/admin/settings/aprovacoes", { types: next });
      setTypes(r.types);
      say("Configuração salva");
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    }
  }

  async function decide(id: string, action: "approve" | "refuse") {
    setBusy(true);
    try {
      await request("POST", `/admin/operations/${id}/${action}`, action === "refuse" ? { reason: reason.trim() } : undefined);
      say(action === "approve" ? "Operação aprovada e enviada" : "Operação recusada");
      setRefusing(null);
      setReason("");
      load();
    } catch (e) {
      say(errMsg(e, "Não foi possível decidir."), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="ch"><h3>Aprovação de operações</h3><small>o que só segue para a rede depois da Speed</small></div>
      <div className="summary" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {all.map((t) => (
            <label key={t} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={types.includes(t)} onChange={(e) => void toggle(t, e.target.checked)} style={{ width: "auto" }} />
              {TYPE_LABEL[t]}
            </label>
          ))}
        </div>
        <small className="muted">Sem nada marcado, bloquear, desbloquear, reiniciar e cancelar seguem direto para a rede. Marcado, o pedido do parceiro espera aqui.</small>

        {pending.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nenhuma operação esperando aprovação.</p>
        ) : (
          <ul className="ops">
            {pending.map((p) => (
              <li key={p.id}>
                <div className="ops-h">
                  <b>{TYPE_LABEL[p.type]}</b>
                  <span>{p.partnerName} · contrato <span className="mono">{p.contract ?? "—"}</span>{p.nickname ? ` · ${p.nickname}` : ""}</span>
                  <small className="muted">{when(p.createdAt)}</small>
                </div>
                {p.reason && <small className="muted">Motivo do parceiro: {p.reason}</small>}
                {refusing === p.id ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo da recusa (obrigatório)" maxLength={300} style={{ flex: 1, minWidth: 220, border: "1px solid var(--line2)", borderRadius: 9, padding: "8px 10px", background: "var(--surf)", color: "var(--ink)" }} />
                    <button className="btn sm" disabled={busy || reason.trim().length < 5} onClick={() => void decide(p.id, "refuse")}>Confirmar recusa</button>
                    <button className="btn sec sm" onClick={() => { setRefusing(null); setReason(""); }}>Voltar</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn sm" disabled={busy} onClick={() => void decide(p.id, "approve")}>Aprovar</button>
                    <button className="btn sec sm" disabled={busy} onClick={() => setRefusing(p.id)}>Recusar</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
