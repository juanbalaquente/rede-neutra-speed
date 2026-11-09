import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useToast } from "./Toast";

const ASCII = /^[\x20-\x7E]+$/;
/** A Wiki exige maiúscula, minúscula, número e caractere especial (senão 422 senha_fraca). */
const classes = (s: string) => ({ maiuscula: /[A-Z]/.test(s), minuscula: /[a-z]/.test(s), numero: /\d/.test(s), especial: /[^A-Za-z0-9 ]/.test(s) });

/** Depois de "não deu para confirmar": a Wiki insiste por até 4 min (29 out 2026); consulta de 10 em 10 s por até 4 min e meio. */
const POLL_MS = 10_000;
const POLL_MAX = 27;

/** A Wiki dá à rede 5 GHz o mesmo nome com `_5G` no fim; o técnico precisa ver os dois. */
export function redes(ssid: string | null | undefined, ssid5: string | null | undefined): string | null {
  if (!ssid) return null;
  return ssid5 ? `Rede 2,4 GHz: ${ssid} · Rede 5 GHz: ${ssid5}` : ssid;
}

const FALHA: Record<string, string> = {
  recusado: "A ONU recusou a troca. Confira se ela está online e tente de novo daqui a pouco.",
  sem_convergencia: "A ONU não confirmou a mudança a tempo. Teste no aparelho antes de repetir.",
  erro_interno: "A Speed teve um erro ao aplicar a troca. Teste no aparelho antes de repetir.",
};

/** `anterior`: o 409 troca_em_andamento, a tela acompanha a troca que já estava em curso. */
type Waiting = { tries: number; anterior?: boolean } | null;

/**
 * Nome e senha do Wi-Fi do cliente, enviados à ONU pela Speed. Usado pelo técnico logo depois da ONU ficar online
 * e pelo suporte na caixa de ações do cliente. A senha fica só em memória: nunca em rascunho (localStorage) e
 * some da tela depois de enviada. O portal também não a guarda.
 *
 * Se a Speed não confirmar a tempo, a troca costuma terminar sozinha: a tela passa a acompanhar o resultado em vez
 * de dizer só "não deu para confirmar".
 */
export function WifiForm({ installationId, onDone, onCancel, submitLabel = "Configurar Wi-Fi" }: { installationId: string; onDone?: (ssid: string | null) => void; onCancel?: () => void; submitLabel?: string }) {
  const say = useToast();
  const [ssid, setSsid] = useState("");
  const [senha, setSenha] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Waiting>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const sentSsid = useRef<string | null>(null);
  // Em ref: o pai passa uma função nova a cada render e isso reiniciaria a consulta de 5 em 5 s.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const ssidOk = ssid === "" || (ssid.length <= 32 && ASCII.test(ssid));
  const c = classes(senha);
  const senhaOk = senha.length >= 8 && senha.length <= 63 && ASCII.test(senha) && c.maiuscula && c.minuscula && c.numero && c.especial;
  const faltam = [!c.maiuscula && "maiúscula", !c.minuscula && "minúscula", !c.numero && "número", !c.especial && "caractere especial (! # $ @)"].filter(Boolean);

  // Acompanha o resultado depois de um "sem confirmação".
  const tries = waiting?.tries;
  const anterior = waiting?.anterior;
  useEffect(() => {
    if (tries === undefined) return;
    const t = setTimeout(async () => {
      let next: Waiting = { tries: tries + 1, anterior };
      try {
        const r = await api.wifiOutcome(installationId);
        if (r.estado === "aplicado") {
          const nomes = redes(r.ssid ?? sentSsid.current, r.ssid5);
          say(nomes ? `Wi-Fi configurado. ${nomes}` : "Wi-Fi configurado.");
          setWaiting(null);
          setVerdict({ ok: true, text: `A Speed confirmou: o Wi-Fi foi aplicado${nomes ? ` (${nomes})` : ""}. Teste no celular.` });
          doneRef.current?.(nomes);
          return;
        }
        if (r.estado === "falhou") {
          setWaiting(null);
          setVerdict({ ok: false, text: FALHA[r.motivo ?? ""] ?? FALHA.erro_interno! });
          return;
        }
        // sem_registro: a Wiki não tem troca desta tentativa (ou reiniciou); tentar de novo ainda pode achar.
      } catch {
        // Consulta fora do ar: tenta de novo até o limite.
      }
      if (next.tries >= POLL_MAX) {
        next = null;
        setVerdict({ ok: false, text: "Não deu para confirmar a troca. Ela pode ter sido aplicada: teste no aparelho antes de repetir." });
      }
      setWaiting(next);
    }, tries === 0 ? 1000 : POLL_MS);
    return () => clearTimeout(t);
  }, [tries, anterior, installationId, say]);

  async function send() {
    setBusy(true);
    setVerdict(null);
    sentSsid.current = ssid.trim() || null;
    try {
      const r = await api.changeWifi(installationId, { ssid: ssid.trim() || null, senha });
      const nomes = redes(r.ssid, r.ssid5);
      say(nomes ? `Wi-Fi configurado. ${nomes}` : "Senha do Wi-Fi configurada.");
      setSenha("");
      onDone?.(nomes);
    } catch (e) {
      setSenha("");
      // 504 da Wiki: ela continua tentando por até 4 min. 409: já havia uma troca em curso; acompanha aquela.
      if (e instanceof ApiError && e.code === "wifi_sem_confirmacao") setWaiting({ tries: 0 });
      else if (e instanceof ApiError && e.code === "troca_em_andamento") setWaiting({ tries: 0, anterior: true });
      else say(e instanceof Error ? e.message : "Falha ao configurar o Wi-Fi.", "bad");
    } finally {
      setBusy(false);
    }
  }

  if (waiting) {
    return (
      <div className="fld" role="status">
        <span>{anterior ? "Troca em andamento: a troca pedida antes ainda está sendo aplicada." : "Aplicando… a Speed está configurando o Wi-Fi nas duas redes."}</span>
        <small>Logo depois de ativar, a ONU pode demorar a responder e a Speed insiste por até 4 minutos. A tela atualiza sozinha; não envie de novo (são 5 trocas por hora).</small>
      </div>
    );
  }

  return (
    <form className="fld" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ssidOk && senhaOk && !busy) void send(); }}>
      <span>Wi-Fi do cliente. A senha vai direto para a ONU e o portal não a guarda; anote ou passe ao cliente agora.</span>
      {verdict && <small className={verdict.ok ? "" : "error"} role="status">{verdict.text}</small>}
      <input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} placeholder="Nome da rede (opcional, sem acento, até 32 letras)" autoComplete="off" />
      <input type={show ? "text" : "password"} value={senha} onChange={(e) => setSenha(e.target.value)} maxLength={63} placeholder="Senha (8 a 63, com maiúscula, minúscula, número e especial)" autoComplete="new-password" spellCheck={false} />
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto", padding: 0 }} checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar a senha
      </label>
      {!ssidOk && <small className="error">O nome da rede não pode ter acento nem ç.</small>}
      {senha !== "" && !senhaOk && (
        <small className="error">
          {!ASCII.test(senha) ? "A senha não pode ter acento nem ç." : senha.length < 8 ? "A senha precisa de pelo menos 8 caracteres." : faltam.length ? `Falta na senha: ${faltam.join(", ")}.` : "A senha passa de 63 caracteres."}
        </small>
      )}
      <small className="muted">A rede 5 GHz recebe o mesmo nome com _5G no fim (ex.: casa e casa_5G) e a mesma senha. A troca leva de 30 segundos a 1 minuto (até 4 logo depois de ativar) e os aparelhos conectados podem cair por instantes. Máximo de 5 trocas por hora.</small>
      <div className="acts2">
        <button className="btn sm" disabled={busy || !ssidOk || !senhaOk}>{busy ? "Enviando…" : submitLabel}</button>
        {onCancel && <button type="button" className="btn sec sm" onClick={onCancel}>Voltar</button>}
      </div>
    </form>
  );
}
