import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Activation, type ActivationState, type PendingOnu, type Reservation } from "../api";
import { newUuid } from "../uuid";
import { PhotoSlots } from "./PhotoSlots";
import { useDraft } from "./useDraft";
import { ContractStep, type ContractStatus } from "./ContractStep";
import { outageText } from "./outage";
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
  aguardando_cliente: "O contrato ainda não chegou ao sistema de rede. A liberação continua sozinha quando ele chegar (pode levar até 2 horas); não refaça o pedido.",
  falha_provisionamento: "A ONU foi autorizada, mas a configuração falhou. A Speed foi avisada; não refaça a instalação. Se a ONU não for Huawei de modelo aceito, avise a Speed para trocar.",
  cancelada: "Ativação cancelada. A reserva continua ativa e você pode tentar de novo.",
  falhou: "A ativação não pôde ser feita.",
};

/** Motivos que a Wiki manda na ativação; código desconhecido aparece como veio. */
const MOTIVO_ATIVACAO: Record<string, string> = {
  nova_tentativa_de_provisionamento: "nova tentativa de configuração",
  provisionamento_falhou: "a configuração da ONU falhou",
  modelo_nao_suportado: "modelo de ONU não aceito",
};

/**
 * A Wiki só configura ONU Huawei gerenciada pelo ACS, fora EG8010H, 546M e 010H (23 out 2026).
 * Serve só para avisar antes de enviar: quem decide é a Wiki, que confere antes de mexer na ONU.
 */
const MODELOS_RECUSADOS = ["010H", "546M"];
function onuProblem(o: Pick<PendingOnu, "serial" | "modelo">): string | null {
  if (!o.serial.toUpperCase().startsWith("HWTC")) return "Não é Huawei: a Speed não configura essa ONU.";
  const modelo = (o.modelo ?? "").toUpperCase();
  if (MODELOS_RECUSADOS.some((m) => modelo.includes(m))) return `O modelo ${o.modelo} não é aceito pela Speed.`;
  return null;
}

/** A configuração (reset de fábrica, senha, IPv6) leva de 2,5 a 5 min, com a ONU uns 2 min fora do ar. */
const PROVISIONING_SLOW_MS = 6 * 60_000;

function Provisioning() {
  const since = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = now - since.current;
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <p className="muted">
      Configurando a ONU: reset de fábrica, senha de acesso e IPv6. Leva de 2 a 5 minutos e a ONU reinicia e fica uns 2 minutos fora do ar; não desligue
      a ONU nem refaça o pedido. <span className="mono">{m}:{String(s).padStart(2, "0")}</span>
      {left > PROVISIONING_SLOW_MS && " Está demorando mais que o normal; a Speed acompanha e a tela segue sozinha."}
    </p>
  );
}

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

  // A Wiki tenta ler o sinal por até 2 min depois de autorizar; sem leitura ela devolve a decisão com este motivo, sem medição.
  const noReading = !sinal && activation.snapshot?.motivo === "sem_leitura_de_sinal";
  return (
    <div className="atv-trava">
      <b>{noReading ? "Não foi possível ler o sinal da ONU" : "Sinal fora do limite"}</b>
      {noReading && (
        <p>
          A ONU foi autorizada, mas o sistema não conseguiu medir o sinal dela em 2 minutos. Confira se a ONU está ligada e com a fibra conectada e <b>meça de novo</b>.
          Se não for possível medir, você pode prosseguir com justificativa (abre chamado para a Infra) ou cancelar a ativação.
        </p>
      )}
      {sinal && sinal.onuDbm !== null && sinal.perdaDb !== null && (
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
  const motivo = activation.snapshot?.motivo;
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
      {outageText(activation.snapshot?.motivo) && !ended ? (
        <p className="error" role="alert">{outageText(activation.snapshot?.motivo)} Não refaça o pedido.</p>
      ) : state === "provisionando" ? (
        <Provisioning />
      ) : (
        note && <p className={ended ? "error" : "muted"}>{note}{motivo && state !== "cancelada" ? ` (${MOTIVO_ATIVACAO[motivo] ?? motivo})` : ""}</p>
      )}
      {activation.snapshot?.vlan && ["provisionando", "online"].includes(state) && (
        <p className="atv-vlan">
          Configure a ONU do cliente com o login <span className="mono">{activation.pppLogin}</span> e a <b>VLAN <span className="mono">{activation.snapshot.vlan}</span></b>.
        </p>
      )}
      {state === "aguardando_decisao" && <Decision activation={activation} onChange={onChange} />}
      {done && (
        <p>
          <span className="badge b-ok">ONU liberada</span>{" "}
          {activation.snapshot?.sinal?.perdaDb != null && <span className="muted">perda de {fmtDb(activation.snapshot.sinal.perdaDb)} dB</span>}
        </p>
      )}
      {done && (
        <p className="atv-vlan">
          O <b>Wi-Fi não é configurado</b> pela Speed: a ONU fica com a rede e a senha de fábrica, as da etiqueta. Passe ao cliente ou troque na hora.
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
  const [onusError, setOnusError] = useState<string | null>(null);
  const [serial, setSerial] = useState("");
  const [confirm, setConfirm] = useState("");
  const [draft, setDraft, clearDraft] = useDraft(`ativacao:${reservation.id}`, { contrato: "", sinal: "" });
  const { contrato, sinal } = draft;
  const setContrato = (v: string) => setDraft({ contrato: v });
  const setSinal = (v: string) => setDraft({ sinal: v });
  const [busy, setBusy] = useState(false);
  const [hasMedicao, setHasMedicao] = useState(false);
  // Com a criação automática ligada, o contrato nasce do sistema da Speed e não é digitado.
  const [contractStatus, setContractStatus] = useState<ContractStatus>({ enabled: false, login: null, contract: null });
  // A chave nasce com o formulário: reenviar o mesmo pedido (rede caiu) não duplica.
  const key = useRef(newUuid());
  const reportedDone = useRef(false);
  const lastPollError = useRef("");

  const loadOnus = useCallback(() => {
    setOnus(null);
    setOnusError(null);
    api.pendingOnus(reservation.id).then((r) => setOnus(r.onus)).catch((e) => {
      const text = e instanceof Error ? e.message : "Falha ao listar as ONUs.";
      say(text, "bad");
      // Fica na tela (não só no aviso): a Speed pode ainda não ter liberado a liberação de ONU.
      setOnusError(text);
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
      api.activation(activationId).then((r) => { lastPollError.current = ""; setActivation(r.activation); }).catch((e) => {
        // Avisa uma vez por erro diferente (a consulta repete a cada 4 s): antes a falha sumia e a tela parecia parada.
        const text = e instanceof Error ? e.message : "Falha ao consultar a ativação.";
        if (text !== lastPollError.current) say(`Não consegui ler o andamento: ${text}`, "bad");
        lastPollError.current = text;
      });
    }, 4000);
    return () => clearInterval(t);
  }, [activationId, activationState, say]);

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
  const selectedOnu = onus?.find((o) => o.serial === serial);
  const selectedProblem = selectedOnu ? onuProblem(selectedOnu) : null;
  const confirmed = serial !== "" && confirm.trim().toUpperCase() === tail.toUpperCase();
  const contractOk = contractStatus.enabled ? !!contractStatus.contract : /^\d{1,12}$/.test(contrato);
  const ready = sinalOk && contractOk && confirmed && !!pppSuffix && hasMedicao;
  // O botão só libera com tudo certo; enquanto não, diz o que falta (um item por vez, na ordem da tela).
  const blocker =
    serial === "" ? "Escolha a ONU na lista."
    : !confirmed ? `Digite os 4 últimos caracteres da etiqueta da ONU (${tail}).`
    : !contractOk ? (contractStatus.enabled ? "Crie o contrato do cliente." : "Informe o número do contrato (só dígitos).")
    : !sinalOk ? "Informe o sinal medido na CTO, entre -40 e 0 dBm."
    : !hasMedicao ? "Falta a foto da medição na CTO."
    : null;

  async function submit() {
    setBusy(true);
    try {
      const r = await api.startActivation({ reservationId: reservation.id, serial, contrato: contractStatus.enabled ? undefined : contrato, sinalCtoDbm: dbm, idempotencyKey: key.current });
      clearDraft();
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
              ) : onusError ? (
                <small className="error" role="alert">{onusError} <button type="button" className="linkbtn" onClick={loadOnus}>Tentar de novo</button></small>
              ) : onus.length === 0 ? (
                <small>Nenhuma ONU aguardando autorização nessa OLT. Ligue a ONU do cliente e <button type="button" className="linkbtn" onClick={loadOnus}>atualize a lista</button>.</small>
              ) : (
                <div className="atv-onus" role="radiogroup" aria-label="ONUs pendentes">
                  {onus.map((o) => (
                    <button key={o.serial} type="button" role="radio" aria-checked={serial === o.serial} className={`atv-onu ${serial === o.serial ? "on" : ""}`} onClick={() => { setSerial(o.serial); setConfirm(""); }}>
                      <span className="mono">{o.serial}</span>
                      <small>{o.modelo} · consultada às {new Date(o.vistaEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>
                      {onuProblem(o) && <small className="error">modelo não aceito</small>}
                    </button>
                  ))}
                </div>
              )}
              <small>Use ONU Huawei gerenciada pela Speed (ex.: EG8145X6, EG8145V5). Não servem outros fabricantes (ZTE, Fiberhome…) nem os modelos EG8010H, 546M e 010H.</small>
            </div>
            {selectedProblem && (
              <p className="error" role="alert">{selectedProblem} A ativação vai terminar em falha e a ONU fica autorizada sem serviço. Troque por uma ONU aceita antes de liberar.</p>
            )}
            {serial && (
              <label className="fld">
                <span>Confirme a etiqueta da ONU</span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={4} placeholder={`últimos 4 caracteres da serial`} autoComplete="off" style={{ maxWidth: 220, textTransform: "uppercase" }} />
                <small>Evita liberar a ONU pendente de outro técnico.</small>
              </label>
            )}
            <ContractStep reservationId={reservation.id} address={reservation.address} saved={reservation.installAddress} onChange={setContractStatus} />
            <div className="g2">
              {!contractStatus.enabled && (
                <label className="fld">
                  <span>Número do contrato</span>
                  <input value={contrato} onChange={(e) => setContrato(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="ex.: 12345" />
                  <small>{contrato ? <>Login PPPoE: <span className="mono">{contrato}-{pppSuffix}</span></> : "O login PPPoE é o contrato com o código do provedor."}</small>
                </label>
              )}
              <label className="fld">
                <span>Sinal medido na CTO (dBm)</span>
                <input value={sinal} onChange={(e) => setSinal(e.target.value)} inputMode="decimal" placeholder="ex.: -20,0" />
                <small>{sinal && !sinalOk ? "Informe um valor entre -40 e 0." : "Meça na porta da CTO antes de instalar. É a referência da trava de sinal."}</small>
              </label>
            </div>
            <PhotoSlots reservationId={reservation.id} onMedicao={setHasMedicao} />
            <div className="acts2">
              <button className="btn" disabled={!ready || busy} onClick={submit}>{busy ? "Enviando…" : "Liberar ONU"}</button>
              {blocker && <small className="muted">{blocker}</small>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
