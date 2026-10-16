import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { clientStatusApi, type AutenticacaoEstado, type ClientStatusView, type ContratoEstado, type FibraEstado, type SignalView } from "../clientStatusApi";
import { SignalChart } from "./SignalChart";
import { useToast } from "./Toast";

type Tone = "ok" | "warn" | "bad" | "mute";

const FIBRA: Record<FibraEstado, { label: string; tone: Tone }> = {
  online: { label: "Online", tone: "ok" },
  offline: { label: "Offline", tone: "bad" },
  loss: { label: "Sem sinal (loss)", tone: "bad" },
  sem_energia: { label: "Sem energia", tone: "bad" },
  inativo: { label: "Inativa", tone: "warn" },
  desabilitada: { label: "Desabilitada", tone: "warn" },
  desconhecido: { label: "Sem leitura", tone: "mute" },
};
const PPP: Record<AutenticacaoEstado, { label: string; tone: Tone }> = {
  conectado: { label: "Conectado", tone: "ok" },
  desconectado: { label: "Desconectado", tone: "bad" },
  desconhecido: { label: "Sem leitura", tone: "mute" },
};
const CONTRATO: Record<ContratoEstado, { label: string; tone: Tone }> = {
  ativo: { label: "Ativo", tone: "ok" },
  bloqueado: { label: "Bloqueado", tone: "warn" },
  suspenso: { label: "Suspenso", tone: "warn" },
  cancelado: { label: "Cancelado", tone: "mute" },
  desconhecido: { label: "Sem leitura", tone: "mute" },
};

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);
const fmtDbm = (n: number | null) => (n === null ? "sem leitura" : `${n.toFixed(1).replace(".", ",")} dBm`);

/** "há 4 min", "há 3 h", "há 2 dias". */
function ago(iso: string | null): string {
  if (!iso) return "sem data";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 90_000) return "agora há pouco";
  if (ms < 3600_000) return `há ${Math.round(ms / 60_000)} min`;
  if (ms < 48 * 3600_000) return `há ${Math.round(ms / 3600_000)} h`;
  return `há ${Math.round(ms / (24 * 3600_000))} dias`;
}
const since = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null);

function Light({ title, label, tone, detail, age, stale }: { title: string; label: string; tone: Tone; detail?: string | null; age: string | null; stale: boolean }) {
  return (
    <div className={`light t-${tone}`}>
      <small>{title}</small>
      <span className="lamp"><i aria-hidden="true" />{label}</span>
      {detail && <span className="mono ld">{detail}</span>}
      <small className={stale ? "stale" : "muted"}>{stale ? `dado velho · ${ago(age)}` : age ? `lido ${ago(age)}` : ""}</small>
    </div>
  );
}

/**
 * Semáforo do cliente instalado: fibra (OLTCloud), PPPoE (NE40) e contrato (Voalle), com o sinal da ONU nos últimos dias.
 * Cada fonte responde por si; uma fora do ar aparece como "Sem leitura", sem derrubar o resto. Só leitura.
 */
export function ClientStatusPanel({ installationId }: { installationId: string }) {
  const say = useToast();
  const [view, setView] = useState<ClientStatusView | null>(null);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(30);
  const [signal, setSignal] = useState<SignalView | null>(null);
  const [signalErr, setSignalErr] = useState<string | null>(null);

  const load = useCallback(
    async (fresh: boolean) => {
      setBusy(true);
      try {
        setView(await clientStatusApi.status(installationId, fresh));
        setProblem(null);
        if (fresh) say("Consultado agora");
      } catch (e) {
        if (e instanceof ApiError) setProblem({ code: e.code, message: e.message });
        else setProblem({ code: "erro", message: errMsg(e, "Falha ao consultar.") });
        if (fresh) say(errMsg(e, "Falha ao consultar."), "bad");
      } finally {
        setBusy(false);
      }
    },
    [installationId, say],
  );
  useEffect(() => { void load(false); }, [load]);

  useEffect(() => {
    let alive = true;
    setSignal(null);
    setSignalErr(null);
    clientStatusApi.signal(installationId, days).then((r) => alive && setSignal(r)).catch((e) => alive && setSignalErr(errMsg(e, "Falha ao carregar o sinal.")));
    return () => { alive = false; };
  }, [installationId, days]);

  // Recurso desligado: não polui a tela do cliente com um aviso de erro.
  if (problem?.code === "status_desligado") return null;

  const s = view?.status;
  return (
    <div className="summary" style={{ borderTop: "1px solid var(--line)", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 500 }}>Situação na rede</b>
        <button className="btn sec sm" disabled={busy} onClick={() => void load(true)}>{busy ? "Consultando…" : "Consultar de novo"}</button>
      </div>

      {problem && <p className="error" role="alert">{problem.message}</p>}
      {!problem && !s && <p className="muted" style={{ margin: 0 }}>Consultando a rede…</p>}

      {s && view && (
        <>
          <div className="lights">
            <Light title="Fibra" label={FIBRA[s.fibra.estado].label} tone={FIBRA[s.fibra.estado].tone} detail={s.fibra.estado === "online" ? fmtDbm(s.fibra.sinalDbm) : null} age={s.fibra.atualizadoEm} stale={view.fibraVelha} />
            <Light title="PPPoE" label={PPP[s.autenticacao.estado].label} tone={PPP[s.autenticacao.estado].tone} detail={s.autenticacao.ip ?? (s.autenticacao.motivo === "pppoe_ainda_nao_disponivel" ? "leitura do PPPoE ainda não disponível" : null)} age={s.autenticacao.atualizadoEm} stale={view.pppoeVelho} />
            <Light title="Contrato" label={CONTRATO[s.contrato.estado].label} tone={CONTRATO[s.contrato.estado].tone} detail={null} age={s.contrato.atualizadoEm} stale={false} />
          </div>
          <div className="g3 os-sum">
            <div><small>Login PPPoE</small><span className="mono">{s.login}</span></div>
            <div><small>ONU</small><span>{s.onu ? <>{s.onu.modelo ?? "ONU"} · <span className="mono">{s.onu.serial}</span></> : "sem dados"}</span></div>
            <div><small>{s.fibra.uptimeDesde ? "No ar desde" : "Última queda"}</small><span>{since(s.fibra.uptimeDesde ?? s.fibra.ultimaQuedaEm) ?? "sem registro"}</span></div>
          </div>
          {s.fibra.estado === "online" && s.fibra.sinalDbm !== null && s.fibra.sinalDbm < view.referencia.minimoDbm && (
            <div className="banner warn" role="status" style={{ margin: 0 }}>
              O sinal atual ({fmtDbm(s.fibra.sinalDbm)}) está abaixo do mínimo aceitável desta instalação ({fmtDbm(view.referencia.minimoDbm)}). Se persistir, abra um chamado de sinal.
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 500 }}>Sinal da ONU</b>
        <div className="seg" role="tablist" aria-label="Período do gráfico" style={{ margin: 0 }}>
          {[7, 30, 90].map((d) => (
            <button key={d} role="tab" aria-selected={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} dias</button>
          ))}
        </div>
      </div>
      {signalErr ? <p className="muted" style={{ margin: 0 }}>{signalErr}</p> : signal ? <SignalChart data={signal} /> : <p className="muted" style={{ margin: 0 }}>Carregando o gráfico…</p>}
    </div>
  );
}
