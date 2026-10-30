import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "./Toast";

const hour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/**
 * Abre a página da ONU em aba nova, por 15 minutos, com o login feito pela Speed. O link é de uso único: fica só na
 * memória desta tela, e só enquanto o navegador não deixou abrir a aba sozinho.
 */
export function RouterAccess({ installationId, onClose }: { installationId: string; onClose: () => void }) {
  const say = useToast();
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiraEm, setExpiraEm] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  // Passados os 15 minutos a página da ONU mostra "Acesso encerrado": a tela volta a oferecer a abertura.
  useEffect(() => {
    if (!expiraEm) return;
    const t = setTimeout(() => { setExpiraEm(null); setLink(null); }, Math.max(0, new Date(expiraEm).getTime() - Date.now()));
    return () => clearTimeout(t);
  }, [expiraEm]);

  async function open() {
    // A resposta pode levar 1 minuto: a aba precisa nascer aqui, no clique, ou o navegador a bloqueia como pop-up.
    const tab = window.open("", "_blank");
    if (tab) tab.document.body.textContent = "Abrindo a página do roteador…";
    setOpening(true);
    setError(null);
    setLink(null);
    try {
      const r = await api.openWebAccess(installationId);
      setExpiraEm(r.expiraEm);
      if (tab && !tab.closed) {
        tab.opener = null;
        tab.location.replace(r.url);
      } else {
        setLink(r.url);
      }
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "Não deu para abrir a página agora.");
    } finally {
      setOpening(false);
    }
  }

  async function close() {
    setClosing(true);
    setError(null);
    try {
      const r = await api.closeWebAccess(installationId);
      say(r.encerrado ? "Acesso encerrado." : "O acesso já estava encerrado.");
      setExpiraEm(null);
      setLink(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não deu para encerrar agora.");
    } finally {
      setClosing(false);
    }
  }

  if (expiraEm) {
    return (
      <div className="fld">
        <span>Acesso à página do roteador aberto até {hour(expiraEm)}.</span>
        {error && <small className="error" role="alert">{error}</small>}
        {link && <small className="muted">O navegador não abriu a aba sozinho. Use o botão abaixo; o link só funciona uma vez.</small>}
        <small className="muted">Depois desse horário, a página mostra "Acesso encerrado". A sessão também pode cair antes, se a Speed atualizar o sistema. Nos dois casos, basta abrir de novo por aqui.</small>
        <div className="acts2">
          {link && <a className="btn sm" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setLink(null)}>Abrir agora</a>}
          <button className="btn sec sm" disabled={opening || closing} onClick={() => void open()}>{opening ? "Abrindo…" : "Abrir de novo"}</button>
          <button className="btn sec sm" disabled={opening || closing} onClick={() => void close()}>{closing ? "Encerrando…" : "Encerrar acesso"}</button>
          <button className="btn sec sm" disabled={opening} onClick={onClose}>Voltar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fld">
      <span>Abrir a página da ONU em outra aba, por 15 minutos? Não precisa digitar usuário nem senha.</span>
      {error && <small className="error" role="alert">{error}</small>}
      <small className="muted">Na primeira abertura, a senha da etiqueta pode deixar de valer para a conta comum desta ONU. Depois disso, o cliente não entra mais com ela.</small>
      <small className="muted">As telas da ONU ficam em inglês. Reset de fábrica, reinício, firmware, contas e senhas, senha da OLT, WAN/PPPoE, regras de acesso à ONU e modo AP estão bloqueados; alguns itens continuam no menu, mas mostram "Não disponível".</small>
      <div className="acts2">
        <button className="btn sm" disabled={opening} onClick={() => void open()}>{opening ? "Abrindo… pode levar até 1 minuto" : "Abrir página"}</button>
        <button className="btn sec sm" disabled={opening} onClick={onClose}>Voltar</button>
      </div>
    </div>
  );
}
