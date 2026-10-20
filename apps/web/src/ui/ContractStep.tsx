import { useCallback, useEffect, useState } from "react";
import { ApiError, request, type Address } from "../api";
import { AddressFields, addressPayload, addressProblem, addressValid, normalizeAddress } from "./AddressFields";
import { newUuid } from "../uuid";
import { useDraft } from "./useDraft";
import { useToast } from "./Toast";

export interface ContractView {
  id: string;
  state: "recebida" | "executando" | "concluida" | "parcial" | "sem_confirmacao" | "aguardando_equipe" | "falhou" | "abandonada";
  steps: { nome: string; estado: "pendente" | "concluida" | "falhou" | "aguardando_equipe"; motivo?: string | null }[];
  contract: string | null;
  login: string | null;
  reason: string | null;
  /** Falhou depois de criar algo no sistema da Speed: não dá para pedir de novo, a Speed conclui ou cancela. */
  needsSpeed?: boolean;
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
  // Proposta à Wiki (21 out 2026): o cliente nasce no OLTCloud junto com o contrato, e a ONU sai sem espera.
  cliente_no_oltcloud: "Cliente no sistema de rede",
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
  create: (id: string, endereco: Address, idempotencyKey: string) => request<{ contract: ContractView }>("POST", `/reservations/${id}/contract`, { endereco, idempotencyKey }),
  retry: (id: string) => request<{ contract: ContractView }>("POST", `/reservations/${id}/contract/retry`),
};

/**
 * Etapa de contrato da liberação da ONU. Com a criação automática ligada, o número do contrato e o login PPPoE
 * nascem do sistema da Speed (não são digitados). Desligada, não renderiza nada e a ativação pede o número à mão.
 */
/** Sugere rua, número, cidade e UF a partir do endereço da consulta ("Rua A, 100, Sabará, MG"). Só preenche; o parceiro confere. */
export function guessAddress(address: string): { rua: string; numero: string; bairro: string; cidade: string; uf: string; cep: string } {
  // A consulta guarda uma linha só, como "Rua X, 123 - Bairro, Cidade - MG, 34505-000, Brasil".
  const cepMatch = /\b(\d{5})-?(\d{3})\b/.exec(address);
  const text = cepMatch ? address.replace(cepMatch[0], "") : address;
  // "212-278" é a faixa de numeração da rua, não um número nem um bairro.
  const parts = text.split(/,| - /).map((p) => p.trim()).filter((p) => p && !/^(brasil|brazil)$/i.test(p) && !/^\d+\s*-\s*\d+$/.test(p));
  const uf = parts.length > 2 && /^[A-Z]{2}$/.test(parts[parts.length - 1]!) ? parts.pop()! : "";
  const numIdx = parts.findIndex((p, i) => i > 0 && /^\d{1,6}[A-Za-z]?$/.test(p));
  const numero = numIdx > 0 ? parts[numIdx]! : "";
  const rest = parts.filter((_, i) => i !== 0 && i !== numIdx);
  return {
    rua: parts[0] ?? "",
    numero,
    bairro: rest.length > 1 ? rest[0]! : "",
    cidade: rest[rest.length - 1] ?? "",
    uf,
    cep: cepMatch ? cepMatch[1]! + cepMatch[2]! : "",
  };
}

export function ContractStep({ reservationId, address, saved, onChange }: { reservationId: string; address?: string; /** Endereço já salvo com os dados do cliente. */ saved?: Address | null; onChange: (s: ContractStatus) => void }) {
  const say = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [contract, setContract] = useState<ContractView | null>(null);
  const [busy, setBusy] = useState(false);
  // Reservas sem endereço salvo (anteriores a esta tela) ainda pedem os campos aqui.
  const savedAddress = saved && addressValid(normalizeAddress(saved)) ? normalizeAddress(saved) : null;
  const [form, setForm, clearForm] = useDraft(`contrato:${reservationId}`, { ...normalizeAddress(address ? guessAddress(address) : null) });
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

  // Segundos desde que o pedido ficou na fila sem nenhuma etapa: só depois de um tempo o "reenviar" faz sentido.
  const queued = contract?.state === "recebida" && contract.steps.length === 0;
  const [queuedFor, setQueuedFor] = useState(0);
  useEffect(() => {
    if (!queued) { setQueuedFor(0); return; }
    const t = setInterval(() => setQueuedFor((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [queued]);

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

  const valid = savedAddress !== null || addressValid(form);

  async function submit() {
    setBusy(true);
    try {
      const r = await api.create(reservationId, addressPayload(savedAddress ?? form), key);
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

  const failed = contract?.state === "falhou" && !contract.needsSpeed;
  const stepList = contract && contract.steps.length > 0 && (
    <ul className="atv-steps" style={{ margin: 0 }}>
      {contract.steps.map((s) => (
        <li key={s.nome} className={s.estado === "concluida" ? "done" : s.estado === "falhou" ? "bad" : ""}>
          <i aria-hidden="true" />{STEP_LABEL[s.nome] ?? s.nome}
          {s.estado === "aguardando_equipe" ? <small className="muted"> (com a equipe da Speed)</small> : null}
          {s.motivo ? <small className="muted"> ({s.motivo})</small> : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="fld" style={{ gap: 8 }}>
      <span>Contrato do cliente</span>
      {contract?.state === "concluida" ? (
        <div className="banner" style={{ margin: 0 }}>
          Contrato <b className="mono">{contract.contract}</b> criado. Login PPPoE: <b className="mono">{contract.login}</b>
        </div>
      ) : contract?.needsSpeed ? (
        <div style={{ display: "grid", gap: 6 }}>
          <p className="error" role="alert" style={{ margin: 0 }}>
            O contrato deste cliente foi criado só em parte no sistema da Speed. A Speed foi avisada e vai concluir ou cancelar. <b>Não crie outro contrato.</b>
          </p>
          {stepList}
        </div>
      ) : contract?.state === "parcial" ? (
        <div style={{ display: "grid", gap: 6 }}>
          {stepList}
          <small>
            A criação parou numa etapa. Repetir continua de onde parou, sem criar outro contrato.{" "}
            <button type="button" className="linkbtn" disabled={busy} onClick={() => void retry()}>Repetir agora</button>
          </small>
        </div>
      ) : contract?.state === "aguardando_equipe" ? (
        <div style={{ display: "grid", gap: 6 }}>
          {stepList}
          <small className="muted">Uma etapa é feita pela equipe da Speed. O contrato aparece aqui quando ela concluir.</small>
        </div>
      ) : contract && !failed ? (
        <div style={{ display: "grid", gap: 6 }}>
          {contract.state === "recebida" && contract.steps.length === 0 ? (
            queuedFor < 30 ? (
              <small className="muted">Enviando o pedido ao sistema da Speed…</small>
            ) : (
              <small>
                O pedido está demorando para chegar ao sistema da Speed. Se continuar assim, reenvie: não cria outro contrato.{" "}
                <button type="button" className="linkbtn" disabled={busy} onClick={() => void retry()}>Reenviar agora</button>
              </small>
            )
          ) : (
            <ul className="atv-steps" style={{ margin: 0 }}>
              {contract.steps.map((s) => (
                <li key={s.nome} className={s.estado === "concluida" ? "done" : s.estado === "falhou" ? "bad" : ""}>
                  <i aria-hidden="true" />{STEP_LABEL[s.nome] ?? s.nome}
                  {s.estado === "aguardando_equipe" ? <small className="muted"> (com a equipe da Speed)</small> : null}
                </li>
              ))}
            </ul>
          )}
          {contract.state !== "recebida" && <small className="muted">Criando o contrato…</small>}
        </div>
      ) : (
        <>
          {failed && <p className="error" role="alert">{REASON_LABEL[contract?.reason ?? ""] ?? "A criação do contrato falhou."} Confira os dados e tente de novo.</p>}
          {savedAddress ? (
            <small>
              Endereço da instalação: <b>{savedAddress.rua}, {savedAddress.numero}{savedAddress.complemento ? ` (${savedAddress.complemento})` : ""} · {savedAddress.bairro}, {savedAddress.cidade}/{savedAddress.uf} · CEP {savedAddress.cep}</b>.
              O número do contrato e o login PPPoE são criados automaticamente. Para corrigir o endereço, use "Dados do cliente".
            </small>
          ) : (
            <>
              <small>Informe o endereço da instalação. O número do contrato e o login PPPoE são criados automaticamente.</small>
              <AddressFields value={form} onChange={setForm} />
            </>
          )}
          <div><button type="button" className="btn sec" disabled={!valid || busy} onClick={() => void submit()}>{busy ? "Enviando…" : "Criar contrato"}</button></div>
          {!valid && !savedAddress && <p className="hint">{addressProblem(form)}</p>}
        </>
      )}
    </div>
  );
}
