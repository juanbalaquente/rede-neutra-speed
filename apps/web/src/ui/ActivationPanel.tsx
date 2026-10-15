import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Activation, type ActivationState, type PendingOnu, type Reservation } from "../api";
import { newUuid } from "../uuid";
import { PhotoSlots } from "./PhotoSlots";
import { useToast } from "./Toast";

const FINAL: ActivationState[] = ["online", "falha_provisionamento", "cancelada", "falhou"];

/** Etapas que o técnico acompanha, na ordem em que acontecem. */
const STEPS: { state: ActivationState; label: string }[] = [
  { state: "autorizando", label: "Autorizando a ONU" },
  { state: "medindo_sinal", label: "Medindo o sinal" },
  { state: "provisionando", label: "Configurando o serviço" },
  { state: "online", label: "ONU online e PPPoE autenticado" },
];

const STATE_NOTE: Partial<Record<ActivationState, string>> = {
  recebida: "Pedido na fila.",
  aguardando_cliente: "O contrato ainda não chegou ao sistema de rede. Aguarde alguns minutos.",
  falha_provisionamento: "A ONU foi autorizada, mas a configuração falhou. A Speed foi avisada; não refaça a instalação.",
  cancelada: "Ativação cancelada. A reserva continua ativa e você pode tentar de novo.",
  falhou: "A ativação não pôde ser feita.",
};

const fmtDb = (n: number) => n.toFixed(1).replace(".", ",");

function stepIndex(state: ActivationState): number {
  if (state === "aguardando_decisao") return 1;
  const i = STEPS.findIndex((s) => s.state === state);
  return i === -1 ? 0 : i;
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return <b className="mono">{m}:{String(s).padStart(2, "0")}</b>;
}

function Decision({ activation, onChange }: { activation: Activation; onChange: (a: Activation) => void }) {
  const say = useToast();
  const [busy, setBusy] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [why, setWhy] = useState("");
  const sinal = activation.snapshot?.sinal;
  const until = activation.snapshot?.prazoDecisaoAte;

  async function send(decision: Parameters<typeof api.decideActivation>[1]) {
    setBusy(true);
    try {
      onChange((await api.decideActivation(activation.id, decision)).activation);
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao enviar a decisão.", "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="atv-trava">
      <b>Sinal fora do limite</b>
      {sinal && (
        <p>
          Na CTO você mediu <span className="mono">{fmtDb(sinal.ctoDbm)} dBm</span>; na ONU deu <span className="mono">{fmtDb(sinal.onuDbm)} dBm</span>.
          A perda é de <b>{fmtDb(sinal.perdaDb)} dB</b>, e o limite é {fmtDb(sinal.limiteDb)} dB.
        </p>
      )}
      {until && <p className="muted">Decida em <Countdown until={until} />. Depois disso a ONU é desautorizada e você recomeça.</p>}
      {!forcing ? (
        <div className="acts2">
          <button className="btn sm" disabled={busy} onClick={() => send({ acao: "remedir" })}>Medir de novo</button>
          <button className="btn sec sm" disabled={busy} onClick={() => setForcing(true)}>Prosseguir mesmo assim</button>
          <button className="btn sec sm danger" disabled={busy} onClick={() => send({ acao: "cancelar" })}>Cancelar a ativação</button>
        </div>
      ) : (
        <div className="fld">
          <span>Justificativa (abre chamado para a Infra)</span>
          <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="ex.: conector refeito, medição repetida com power meter" autoFocus />
          <small>Mínimo 10 caracteres.</small>
          <div className="acts2">
            <button className="btn sm" disabled={busy || why.trim().length < 10} onClick={() => send({ acao: "prosseguir", justificativa: why.trim() })}>Prosseguir</button>
            <button className="btn sec sm" onClick={() => setForcing(false)}>Voltar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Progress({ activation, onChange }: { activation: Activation; onChange: (a: Activation) => void }) {
  const state = activation.state;
  const current = stepIndex(state);
  const done = state === "online";
  const ended = FINAL.includes(state) && !done;
  const note = STATE_NOTE[state];
  return (
    <div className="atv-prog">
      <div className="atv-id">
        <span className="mono">{activation.serial}</span>
        <span className="muted">login <span className="mono">{activation.pppLogin}</span></span>
      </div>
      <ol className="atv-steps">
        {STEPS.map((s, i) => {
          const status = done || i < current ? "done" : i === current && !ended ? "now" : "todo";
          return (
            <li key={s.state} className={status}>
              <i aria-hidden="true" />
              {s.label}
            </li>
          );
        })}
      </ol>
      {note && <p className={ended ? "error" : "muted"}>{note}{activation.snapshot?.motivo && state !== "cancelada" ? ` (${activation.snapshot.motivo})` : ""}</p>}
      {state === "aguardando_decisao" && <Decision activation={activation} onChange={onChange} />}
      {done && (
        <p>
          <span className="badge b-ok">ONU liberada</span>{" "}
          {activation.snapshot?.sinal && <span className="muted">perda de {fmtDb(activation.snapshot.sinal.perdaDb)} dB</span>}
        </p>
      )}
    </div>
  );
}

/** Liberação de ONU de uma reserva: escolher a ONU pendente, informar contrato e sinal da CTO, acompanhar. */
export function ActivationPanel({
  reservation,
  existing,
  pppSuffix,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  existing: Activation | null;
  pppSuffix: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const say = useToast();
  const [activation, setActivation] = useState<Activation | null>(existing);
  const [onus, setOnus] = useState<PendingOnu[] | null>(null);
  const [serial, setSerial] = useState("");
  const [confirm, setConfirm] = useState("");
  const [contrato, setContrato] = useState("");
  const [sinal, setSinal] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMedicao, setHasMedicao] = useState(false);
  // A chave nasce com o formulário: reenviar o mesmo pedido (rede caiu) não duplica.
  const key = useRef(newUuid());
  const reportedDone = useRef(false);

  const loadOnus = useCallback(() => {
    setOnus(null);
    api.pendingOnus(reservation.id).then((r) => setOnus(r.onus)).catch((e) => {
      say(e instanceof Error ? e.message : "Falha ao listar as ONUs.", "bad");
      setOnus([]);
    });
  }, [reservation.id, say]);

  const needsList = activation === null;
  useEffect(() => {
    if (needsList) loadOnus();
  }, [needsList, loadOnus]);

  // Acompanha enquanto não terminou.
  const activationId = activation?.id;
  const activationState = activation?.state;
  useEffect(() => {
    if (!activationId || !activationState || FINAL.includes(activationState)) return;
    const t = setInterval(() => {
      api.activation(activationId).then((r) => setActivation(r.activation)).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [activationId, activationState]);

  useEffect(() => {
    if (activationState === "online" && !reportedDone.current) {
      reportedDone.current = true;
      say("ONU liberada");
      onDone();
    }
  }, [activationState, say, onDone]);

  const dbm = Number(sinal.replace(",", "."));
  const sinalOk = sinal.trim() !== "" && Number.isFinite(dbm) && dbm <= 0 && dbm >= -40;
  const tail = serial.slice(-4);
  const confirmed = serial !== "" && confirm.trim().toUpperCase() === tail.toUpperCase();
  const ready = sinalOk && /^\d{1,12}$/.test(contrato) && confirmed && !!pppSuffix && hasMedicao;

  async function submit() {
    setBusy(true);
    try {
      const r = await api.startActivation({ reservationId: reservation.id, serial, contrato, sinalCtoDbm: dbm, idempotencyKey: key.current });
      setActivation(r.activation);
    } catch (e) {
      const text = e instanceof ApiError ? e.message : "Falha ao pedir a ativação.";
      say(text, "bad");
      // Serial recusada: a lista pode ter mudado.
      if (e instanceof ApiError && e.code === "serial_nao_pendente") loadOnus();
      key.current = newUuid();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card atv">
      <div className="ch">
        <div>
          <h3>Liberar ONU</h3>
          <small className="mono">{reservation.ctoName}</small>
        </div>
        <button className="btn sec sm" onClick={onClose}>Fechar</button>
      </div>
      <div className="summary">
        {activation ? (
          <>
            <Progress activation={activation} onChange={setActivation} />
            <PhotoSlots reservationId={reservation.id} onMedicao={setHasMedicao} />
          </>
        ) : !pppSuffix ? (
          <p className="note">Seu provedor ainda não tem código cadastrado. Peça à Speed para cadastrar antes de liberar ONUs.</p>
        ) : (
          <>
            <div className="fld">
              <span>ONU a liberar</span>
              {onus === null ? (
                <small>Buscando ONUs aguardando autorização…</small>
              ) : onus.length === 0 ? (
                <small>Nenhuma ONU aguardando autorização nessa OLT. Ligue a ONU do cliente e <button type="button" className="linkbtn" onClick={loadOnus}>atualize a lista</button>.</small>
              ) : (
                <div className="atv-onus" role="radiogroup" aria-label="ONUs pendentes">
                  {onus.map((o) => (
                    <button key={o.serial} type="button" role="radio" aria-checked={serial === o.serial} className={`atv-onu ${serial === o.serial ? "on" : ""}`} onClick={() => { setSerial(o.serial); setConfirm(""); }}>
                      <span className="mono">{o.serial}</span>
                      <small>{o.modelo} · apareceu às {new Date(o.vistaEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {serial && (
              <label className="fld">
                <span>Confirme a etiqueta da ONU</span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={4} placeholder={`últimos 4 caracteres da serial`} autoComplete="off" style={{ maxWidth: 220, textTransform: "uppercase" }} />
                <small>Evita liberar a ONU pendente de outro técnico.</small>
              </label>
            )}
            <div className="g2">
              <label className="fld">
                <span>Número do contrato</span>
                <input value={contrato} onChange={(e) => setContrato(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="ex.: 12345" />
                <small>{contrato ? <>Login PPPoE: <span className="mono">{contrato}-{pppSuffix}</span></> : "O login PPPoE é o contrato com o código do provedor."}</small>
              </label>
              <label className="fld">
                <span>Sinal medido na CTO (dBm)</span>
                <input value={sinal} onChange={(e) => setSinal(e.target.value)} inputMode="decimal" placeholder="ex.: -20,0" />
                <small>{sinal && !sinalOk ? "Informe um valor entre -40 e 0." : "Meça na porta da CTO antes de instalar. É a referência da trava de sinal."}</small>
              </label>
            </div>
            <PhotoSlots reservationId={reservation.id} onMedicao={setHasMedicao} />
            <div className="acts2">
              <button className="btn" disabled={!ready || busy} onClick={submit}>{busy ? "Enviando…" : "Liberar ONU"}</button>
              {!hasMedicao && <small className="muted">Falta a foto da medição na CTO.</small>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
