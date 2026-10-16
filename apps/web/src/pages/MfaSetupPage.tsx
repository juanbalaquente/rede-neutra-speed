import { useEffect, useState, type FormEvent } from "react";
import { api, type User } from "../api";

/**
 * Configuração obrigatória do segundo fator (supervisor e administrador): QR code, confirmação
 * com um código e, uma única vez, os códigos de recuperação.
 */
export function MfaSetupPage({ user, onDone, onLogout }: { user: User; onDone: () => void; onLogout: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.setup2fa().then(setSetup).catch((e) => setError(e instanceof Error ? e.message : "Falha ao preparar o QR code."));
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes((await api.enable2fa(code)).recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao confirmar.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText((codes ?? []).join("\n"));
      setCopied(true);
    } catch {
      setError("Não foi possível copiar. Selecione os códigos e copie à mão.");
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login mfa">
        <div className="org">
          <div className="lg"><i /></div>
          <div>
            <b>Rede Neutra</b>
            <small>{user.name}</small>
          </div>
        </div>

        {codes === null ? (
          <form onSubmit={confirm} style={{ display: "grid", gap: 14 }}>
            <h1>Proteja sua conta</h1>
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              Seu perfil exige verificação em duas etapas. Leia o QR code com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Vaultwarden…) e digite o código que ele mostrar.
            </p>
            {setup ? (
              <div className="mfa-qr">
                <img src={setup.qr} alt="QR code para o aplicativo autenticador" width={220} height={220} />
                <small className="muted">
                  Sem câmera? Digite a chave no aplicativo:<br />
                  <span className="mono" style={{ wordBreak: "break-all", userSelect: "all" }}>{setup.secret}</span>
                </small>
              </div>
            ) : (
              !error && <p className="muted">Gerando o QR code…</p>
            )}
            <label>
              Código de 6 dígitos
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" style={{ fontFamily: "var(--mono)", letterSpacing: 4 }} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn" disabled={busy || !setup || code.length !== 6}>{busy ? "Confirmando…" : "Confirmar e ativar"}</button>
            <button type="button" className="linkbtn" onClick={onLogout}>Sair</button>
          </form>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            <h1>Guarde seus códigos de recuperação</h1>
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              Se você perder o celular, cada código abaixo entra uma vez no lugar do aplicativo. <b>Eles não aparecem de novo.</b> Guarde no Vaultwarden ou em outro lugar seguro.
            </p>
            <ul className="mfa-codes" aria-label="Códigos de recuperação">
              {codes.map((c) => <li key={c} className="mono">{c}</li>)}
            </ul>
            {error && <p className="error">{error}</p>}
            <button type="button" className="btn sec" onClick={() => void copy()}>{copied ? "Copiado" : "Copiar os códigos"}</button>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: "auto" }} />
              Guardei os códigos em um lugar seguro
            </label>
            <button className="btn" disabled={!saved} onClick={onDone}>Continuar</button>
          </div>
        )}
      </div>
    </div>
  );
}
