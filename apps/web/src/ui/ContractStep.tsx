import { useCallback, useEffect, useState } from "react";
import { ApiError, request } from "../api";
import { newUuid } from "../uuid";
import { useDraft } from "./useDraft";
import { useToast } from "./Toast";

export interface ContractView {
  id: string;
  state: "recebida" | "executando" | "concluida" | "parcial" | "sem_confirmacao" | "aguardando_equipe" | "falhou";
  steps: { nome: string; estado: "pendente" | "concluida" | "falhou"; motivo?: string | null }[];
  contract: string | null;
  login: string | null;
  reason: string | null;
}

export interface ContractStatus {
  enabled: boolean;
  /** Contrato criado e pronto para a ativação. */
  login: string | null;
  contract: string | null;
}

const STEP_LABEL: Record<string, string> = {
  contrato_criado: "Contrato criado no sistema da Speed",
  conexao_ajustada: "Conexão PPPoE configurada",
  endereco_gravado: "Endereço de instalação gravado",
};

const REASON_LABEL: Record<string, string> = {
  parceiro_sem_cadastro: "O parceiro ainda não está cadastrado no sistema da Speed. Fale com a Speed.",
  plano_nao_configurado: "Esse plano ainda não está configurado para criar contrato. Fale com a Speed.",
  falha_na_wiki: "A criação do contrato falhou. Tente de novo ou fale com a Speed.",
  resposta_inconsistente: "A resposta do sistema não bateu com o esperado. Fale com a Speed.",
};

const IN_PROGRESS: ContractView["state"][] = ["recebida", "executando", "parcial", "aguardando_equipe"];

const api = {
  get: (id: string) => request<{ enabled: boolean; contract: ContractView | null }>("GET", `/reservations/${id}/contract`),
  create: (id: string, endereco: Record<string, string>, idempotencyKey: string) => request<{ contract: ContractView }>("POST", `/reservations/${id}/contract`, { endereco, idempotencyKey }),
  retry: (id: string) => request<{ contract: ContractView }>("POST", `/reservations/${id}/contract/retry`),
};

/**
 * Etapa de contrato da liberação da ONU. Com a criação automática ligada, o número do contrato e o login PPPoE
 * nascem do sistema da Speed (não são digitados). Desligada, não renderiza nada e a ativação pede o número à mão.
 */
export function ContractStep({ reservationId, onChange }: { reservationId: string; onChange: (s: ContractStatus) => void }) {
  const say = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [contract, setContract] = useState<ContractView | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm, clearForm] = useDraft(`contrato:${reservationId}`, { cep: "", rua: "", numero: "", complemento: "", bairro: "", cidade: "", uf: "MG" });
  const [key, setKey] = useState(newUuid);

  const apply = useCallback(
    (on: boolean, c: ContractView | null) => {
      setEnabled(on);
      setContract(c);
      onChange({ enabled: on, login: c?.state === "concluida" ? c.login : null, contract: c?.state === "concluida" ? c.contract : null });
    },
    [onChange],
  );

  useEffect(() => {
    let alive = true;
    api.get(reservationId).then((r) => alive && apply(r.enabled, r.contract)).catch(() => alive && apply(false, null));
    return () => { alive = false; };
  }, [reservationId, apply]);

  // Acompanha enquanto a Wiki cria.
  const inProgress = contract !== null && IN_PROGRESS.includes(contract.state);
  useEffect(() => {
    if (!enabled || !contract || !inProgress) return;
    const t = setInterval(() => {
      api.get(reservationId).then((r) => apply(r.enabled, r.contract)).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [enabled, contract, inProgress, reservationId, apply]);

  if (!enabled) return null;

  const cep = form.cep.replace(/\D/g, "");
  const valid = cep.length === 8 && form.rua.trim().length >= 2 && form.numero.trim() !== "" && form.bairro.trim().length >= 2 && form.cidade.trim().length >= 2 && /^[A-Za-z]{2}$/.test(form.uf.trim());

  async function submit() {
    setBusy(true);
    try {
      const r = await api.create(reservationId, { ...form, cep, uf: form.uf.trim().toUpperCase() }, key);
      clearForm();
      apply(true, r.contract);
    } catch (e) {
      say(e instanceof ApiError ? e.message : "Falha ao pedir o contrato.", "bad");
      // Recusa: o pedido ficou "falhou" e um novo precisa de chave nova.
      setKey(newUuid());
      api.get(reservationId).then((r) => apply(r.enabled, r.contract)).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      apply(true, (await api.retry(reservationId)).contract);
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao reenviar.", "bad");
    } finally {
      setBusy(false);
    }
  }

  const failed = contract?.state === "falhou";

  return (
    <div className="fld" style={{ gap: 8 }}>
      <span>Contrato do cliente</span>
      {contract?.state === "concluida" ? (
        <div className="banner" style={{ margin: 0 }}>
          Contrato <b className="mono">{contract.contract}</b> criado. Login PPPoE: <b className="mono">{contract.login}</b>
        </div>
      ) : contract && !failed ? (
        <div style={{ display: "grid", gap: 6 }}>
          {contract.state === "recebida" && contract.steps.length === 0 ? (
            <small>
              O pedido está guardado, mas ainda não chegou ao sistema da Speed.{" "}
              <button type="button" className="linkbtn" disabled={busy} onClick={() => void retry()}>Reenviar agora</button>
            </small>
          ) : (
            <ul className="atv-steps" style={{ margin: 0 }}>
              {contract.steps.map((s) => (
                <li key={s.nome} className={s.estado === "concluida" ? "done" : s.estado === "falhou" ? "bad" : ""}>
                  <i aria-hidden="true" />{STEP_LABEL[s.nome] ?? s.nome}
                </li>
              ))}
            </ul>
          )}
          {contract.state !== "recebida" && <small className="muted">Criando o contrato…</small>}
        </div>
      ) : (
        <>
          {failed && <p className="error" role="alert">{REASON_LABEL[contract?.reason ?? ""] ?? "A criação do contrato falhou."} Confira os dados e tente de novo.</p>}
          <small>Informe o endereço da instalação. O número do contrato e o login PPPoE são criados automaticamente.</small>
          <div className="g2">
            <label className="fld"><span>CEP</span><input value={form.cep} onChange={(e) => setForm({ cep: e.target.value.replace(/\D/g, "").slice(0, 8) })} inputMode="numeric" placeholder="34505000" /></label>
            <label className="fld"><span>Rua</span><input value={form.rua} onChange={(e) => setForm({ rua: e.target.value })} maxLength={120} /></label>
          </div>
          <div className="g3">
            <label className="fld"><span>Número</span><input value={form.numero} onChange={(e) => setForm({ numero: e.target.value })} maxLength={12} /></label>
            <label className="fld"><span>Complemento</span><input value={form.complemento} onChange={(e) => setForm({ complemento: e.target.value })} maxLength={60} /></label>
            <label className="fld"><span>Bairro</span><input value={form.bairro} onChange={(e) => setForm({ bairro: e.target.value })} maxLength={80} /></label>
          </div>
          <div className="g2">
            <label className="fld"><span>Cidade</span><input value={form.cidade} onChange={(e) => setForm({ cidade: e.target.value })} maxLength={80} /></label>
            <label className="fld"><span>UF</span><input value={form.uf} onChange={(e) => setForm({ uf: e.target.value.slice(0, 2).toUpperCase() })} maxLength={2} style={{ maxWidth: 90 }} /></label>
          </div>
          <div><button type="button" className="btn sec" disabled={!valid || busy} onClick={() => void submit()}>{busy ? "Enviando…" : "Criar contrato"}</button></div>
        </>
      )}
    </div>
  );
}
