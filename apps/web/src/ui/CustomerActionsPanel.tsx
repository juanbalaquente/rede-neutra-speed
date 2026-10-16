import { useCallback, useEffect, useState } from "react";
import { api, type CustomerOperation, type OperationState, type OperationType, type User } from "../api";
import { useToast } from "./Toast";

const TYPE_LABEL: Record<OperationType, string> = { bloqueio: "Bloqueio", desbloqueio: "Desbloqueio", reinicio: "Reinício da ONU", cancelamento: "Cancelamento" };
const STEP_LABEL: Record<string, string> = { contrato_encerrado: "Contrato encerrado", onu_removida: "ONU removida da rede", porta_devolvida: "Vaga devolvida" };
const STATE: Record<OperationState, { label: string; tone: string }> = {
  recebida: { label: "Na fila", tone: "b-data" },
  executando: { label: "Executando", tone: "b-data" },
  concluida: { label: "Concluída", tone: "b-ok" },
  parcial: { label: "Parcial: repita", tone: "b-warn" },
  sem_confirmacao: { label: "Sem confirmação", tone: "b-warn" },
  aguardando_equipe: { label: "Com a equipe da Speed", tone: "b-data" },
  falhou: { label: "Falhou", tone: "b-bad" },
  aguardando_aprovacao: { label: "Aguardando aprovação da Speed", tone: "b-warn" },
  recusada: { label: "Recusada pela Speed", tone: "b-bad" },
};
const OPEN: OperationState[] = ["recebida", "executando", "parcial", "aguardando_equipe", "aguardando_aprovacao"];

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

/**
 * Ações sobre o cliente final: bloquear e desbloquear (mantém a porta e a cobrança), reiniciar a ONU e
 * cancelar (encerra o contrato, remove a ONU e devolve a vaga). Quem executa é a Speed, por automação.
 */
export function CustomerActionsPanel({ installationId, customerStatus, user, onChanged }: { installationId: string; customerStatus: "ativo" | "bloqueado" | "cancelado"; user: User; onChanged: () => void }) {
  const say = useToast();
  const [ops, setOps] = useState<CustomerOperation[] | null>(null);
  const [asking, setAsking] = useState<OperationType | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.operations(installationId).then((r) => setOps(r.operations)).catch(() => setOps([]));
  }, [installationId]);
  useEffect(load, [load]);

  // Acompanha a operação aberta: pergunta à Speed a cada poucos segundos.
  const open = ops?.find((o) => OPEN.includes(o.state) && o.state !== "parcial" && o.state !== "aguardando_equipe" && o.state !== "aguardando_aprovacao") ?? null;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      api.operation(open.id).then((r) => {
        setOps((cur) => cur?.map((o) => (o.id === r.operation.id ? r.operation : o)) ?? cur);
        if (r.operation.state === "concluida") onChanged();
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [open?.id, open?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(type: OperationType) {
    setBusy(true);
    try {
      await api.startOperation(installationId, { type, reason: reason.trim() || null });
      say(type === "cancelamento" ? "Cancelamento pedido. Acompanhe as etapas." : "Pedido enviado.");
      setAsking(null);
      setReason("");
      load();
    } catch (e) {
      say(errMsg(e, "Falha ao pedir a operação."), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function retry(id: string) {
    try {
      await api.retryOperation(id);
      say("Repetindo de onde parou.");
      load();
    } catch (e) {
      say(errMsg(e, "Falha ao repetir."), "bad");
    }
  }

  const cancelled = customerStatus === "cancelado";
  const hasOpen = !!ops?.some((o) => OPEN.includes(o.state));
  const needsReason = asking === "cancelamento";

  return (
    <div className="summary" style={{ borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <b style={{ fontWeight: 500 }}>Ações do cliente</b>
        <span className={`badge ${customerStatus === "ativo" ? "b-ok" : customerStatus === "bloqueado" ? "b-warn" : "b-mute"}`}>
          {customerStatus === "ativo" ? "Contrato ativo" : customerStatus === "bloqueado" ? "Bloqueado" : "Cancelado"}
        </span>
      </div>

      {!cancelled && asking === null && (
        <div className="acts2">
          {customerStatus === "ativo" ? (
            <button className="btn sec sm" disabled={hasOpen} onClick={() => setAsking("bloqueio")}>Bloquear</button>
          ) : (
            <button className="btn sec sm" disabled={hasOpen} onClick={() => setAsking("desbloqueio")}>Desbloquear</button>
          )}
          <button className="btn sec sm" disabled={hasOpen} onClick={() => setAsking("reinicio")}>Reiniciar ONU</button>
          {user.role === "supervisor" && <button className="btn sec sm danger" disabled={hasOpen} onClick={() => setAsking("cancelamento")}>Cancelar cliente</button>}
        </div>
      )}

      {asking && (
        <div className="fld">
          <span>
            {asking === "bloqueio" && "Bloquear o acesso por inadimplência? O cliente continua ocupando a porta e sendo cobrado pela Speed."}
            {asking === "desbloqueio" && "Devolver o acesso ao cliente?"}
            {asking === "reinicio" && "Reiniciar a ONU? O cliente fica cerca de 1 minuto sem internet."}
            {asking === "cancelamento" && "Cancelar o cliente? O contrato é encerrado, a ONU sai da rede e a vaga volta para a Speed. Não dá para desfazer."}
          </span>
          {(asking === "cancelamento" || asking === "bloqueio") && (
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={asking === "cancelamento" ? "Motivo (obrigatório)" : "Motivo (opcional)"} autoFocus />
          )}
          <div className="acts2">
            <button className={`btn sm ${asking === "cancelamento" ? "danger-solid" : ""}`} disabled={busy || (needsReason && reason.trim().length < 3)} onClick={() => void run(asking)}>
              {busy ? "Enviando…" : asking === "cancelamento" ? "Sim, cancelar o cliente" : "Confirmar"}
            </button>
            <button className="btn sec sm" onClick={() => { setAsking(null); setReason(""); }}>Voltar</button>
          </div>
        </div>
      )}

      {ops && ops.length > 0 && (
        <ul className="ops">
          {ops.map((o) => (
            <li key={o.id}>
              <div className="ops-h">
                <b>{TYPE_LABEL[o.type]}</b>
                <span className={`badge ${STATE[o.state].tone}`}>{STATE[o.state].label}</span>
                <small className="muted">{when(o.createdAt)}</small>
                {o.state === "parcial" && <button className="linkbtn" onClick={() => void retry(o.id)}>Repetir</button>}
              </div>
              {o.reason && <small className="muted">{o.reason}</small>}
              {o.state === "recusada" && o.decisionReason && <small style={{ color: "var(--bad)" }}>Motivo da Speed: {o.decisionReason}</small>}
              {o.steps.length > 0 && (
                <ol className="atv-steps ops-steps">
                  {o.steps.map((s) => (
                    <li key={s.nome} className={s.estado === "concluida" ? "done" : s.estado === "falhou" ? "bad" : ""}>
                      <i aria-hidden="true" />
                      {STEP_LABEL[s.nome] ?? s.nome}
                      {s.motivo ? <small className="muted"> ({s.motivo})</small> : null}
                    </li>
                  ))}
                </ol>
              )}
              {o.state === "sem_confirmacao" && <small className="muted">A ONU não confirmou o reinício. Confira o status antes de tentar de novo.</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
