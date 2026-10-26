import { useState } from "react";
import { api } from "../api";
import { useToast } from "./Toast";

const ASCII = /^[\x20-\x7E]+$/;
/** A Wiki exige maiúscula, minúscula, número e caractere especial (senão 422 senha_fraca). */
const classes = (s: string) => ({ maiuscula: /[A-Z]/.test(s), minuscula: /[a-z]/.test(s), numero: /\d/.test(s), especial: /[^A-Za-z0-9 ]/.test(s) });

/**
 * Nome e senha do Wi-Fi do cliente, enviados à ONU pela Speed. Usado pelo técnico logo depois da ONU ficar online
 * e pelo suporte na caixa de ações do cliente. A senha fica só em memória: nunca em rascunho (localStorage) e
 * some da tela depois de enviada. O portal também não a guarda.
 */
export function WifiForm({ installationId, onDone, onCancel, submitLabel = "Configurar Wi-Fi" }: { installationId: string; onDone?: (ssid: string | null) => void; onCancel?: () => void; submitLabel?: string }) {
  const say = useToast();
  const [ssid, setSsid] = useState("");
  const [senha, setSenha] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const ssidOk = ssid === "" || (ssid.length <= 32 && ASCII.test(ssid));
  const c = classes(senha);
  const senhaOk = senha.length >= 8 && senha.length <= 63 && ASCII.test(senha) && c.maiuscula && c.minuscula && c.numero && c.especial;
  const faltam = [!c.maiuscula && "maiúscula", !c.minuscula && "minúscula", !c.numero && "número", !c.especial && "caractere especial (! # $ @)"].filter(Boolean);

  async function send() {
    setBusy(true);
    try {
      const r = await api.changeWifi(installationId, { ssid: ssid.trim() || null, senha });
      say(r.ssid ? `Wi-Fi configurado (rede ${r.ssid}).` : "Senha do Wi-Fi configurada.");
      setSenha("");
      onDone?.(r.ssid);
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao configurar o Wi-Fi.", "bad");
      setSenha("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fld" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (ssidOk && senhaOk && !busy) void send(); }}>
      <span>Wi-Fi do cliente. A senha vai direto para a ONU e o portal não a guarda; anote ou passe ao cliente agora.</span>
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
      <small className="muted">A troca leva cerca de 30 segundos (as duas redes, 2,4 e 5 GHz) e os aparelhos conectados podem cair por instantes. Máximo de 5 trocas por hora.</small>
      <div className="acts2">
        <button className="btn sm" disabled={busy || !ssidOk || !senhaOk}>{busy ? "Enviando…" : submitLabel}</button>
        {onCancel && <button type="button" className="btn sec sm" onClick={onCancel}>Voltar</button>}
      </div>
    </form>
  );
}
