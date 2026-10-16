import { useState, type FormEvent } from "react";
import { api, type MfaState, type User } from "../api";

export function LoginPage({ onLogin }: { onLogin: (u: User, mfa: MfaState) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Preenchido quando a senha está certa e falta o código do aplicativo.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge === null) {
        const r = await api.login(email, password);
        if ("challenge" in r) {
          setChallenge(r.challenge);
          setPassword("");
        } else onLogin(r.user, r.mfa);
      } else {
        const r = await api.login2fa(challenge, useRecovery ? { recoveryCode: code } : { code });
        onLogin(r.user, r.mfa);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no login.");
      // Desafio vencido: volta para e-mail e senha.
      if ((err as { code?: string }).code === "desafio_expirado") {
        setChallenge(null);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div className="org">
      <div className="lg"><i /></div>
      <div>
        <b>Rede Neutra</b>
        <small>Portal do parceiro Speed</small>
      </div>
    </div>
  );

  return (
    <div className="login-wrap">
      {challenge === null ? (
        <form className="card login" onSubmit={submit}>
          {header}
          <h1>Entrar</h1>
          <label>
            E-mail
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Senha
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        </form>
      ) : (
        <form className="card login" onSubmit={submit}>
          {header}
          <h1>Verificação em duas etapas</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            {useRecovery ? "Digite um dos seus códigos de recuperação. Cada um vale uma vez." : "Digite o código de 6 dígitos do seu aplicativo autenticador."}
          </p>
          <label>
            {useRecovery ? "Código de recuperação" : "Código"}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              maxLength={useRecovery ? 20 : 6}
              placeholder={useRecovery ? "xxxxx-xxxxx" : "000000"}
              style={{ fontFamily: "var(--mono)", letterSpacing: useRecovery ? 0 : 4 }}
              autoFocus
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy || (!useRecovery && code.length !== 6)}>{busy ? "Verificando…" : "Verificar"}</button>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <button type="button" className="linkbtn" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}>
              {useRecovery ? "Usar o aplicativo" : "Usar código de recuperação"}
            </button>
            <button type="button" className="linkbtn" onClick={() => { setChallenge(null); setCode(""); setError(null); setUseRecovery(false); }}>Voltar</button>
          </div>
        </form>
      )}
    </div>
  );
}
