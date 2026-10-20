import { useEffect, useState, type FormEvent } from "react";
import { api, request, type Reservation } from "../api";
import { AddressFields, addressPayload, addressProblem, normalizeAddress } from "./AddressFields";
import { guessAddress } from "./ContractStep";
import { useDraft } from "./useDraft";
import { useToast } from "./Toast";

/** Valor para `<input type="datetime-local">` (hora local, sem fuso). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Dados do cliente (planejamento, etapa 3): plano, apelido, data da visita e técnico.
 * Plano, visita e técnico são exigidos para liberar a ONU; o apelido nunca vai para o Voalle.
 */
export function ClienteForm({ reservation, onSaved, onClose }: { reservation: Reservation; onSaved: () => void; onClose: () => void }) {
  const say = useToast();
  const [plans, setPlans] = useState<{ id: string; name: string; speedMbps: number }[] | null>(null);
  const [techs, setTechs] = useState<string[]>([]);
  // Rascunho: o que foi digitado sobrevive a recarregar a página (uso em campo, conexão ruim).
  const [draft, setDraft, clearDraft] = useDraft(`cliente:${reservation.id}`, {
    planId: reservation.planId ?? "",
    nickname: reservation.nickname ?? "",
    visit: toLocalInput(reservation.visitAt),
    tech: reservation.technician ?? "",
  });
  const { planId, nickname, visit, tech } = draft;
  const setPlanId = (v: string) => setDraft({ planId: v });
  const setNickname = (v: string) => setDraft({ nickname: v });
  const setVisit = (v: string) => setDraft({ visit: v });
  const setTech = (v: string) => setDraft({ tech: v });
  // Endereço da instalação (vira o do contrato): salvo no mesmo formulário. Na primeira vez sugere o da consulta.
  const [addr, setAddr, clearAddr] = useDraft(`endereco:${reservation.id}`, {
    ...normalizeAddress(reservation.installAddress ?? guessAddress(reservation.address)),
  });
  // Só pede endereço quando o contrato é criado pelo portal e ainda não foi pedido.
  const [needsAddress, setNeedsAddress] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.plans().then((r) => setPlans(r.plans)).catch(() => setPlans([]));
    api.technicians().then((r) => setTechs(r.technicians)).catch(() => {});
    request<{ enabled: boolean; contract: { state: string } | null }>("GET", `/reservations/${reservation.id}/contract`)
      .then((r) => setNeedsAddress(r.enabled && (r.contract === null || r.contract.state === "falhou")))
      .catch(() => setNeedsAddress(false));
  }, [reservation.id]);

  // Mesma janela do servidor: a visita pode ter passado há até um dia e ficar a até um ano.
  const visitMs = visit ? new Date(visit).getTime() : NaN;
  const dateChanged = visit !== toLocalInput(reservation.visitAt);
  const minVisit = toLocalInput(new Date(Date.now() - 24 * 3600_000).toISOString());
  const maxVisit = toLocalInput(new Date(Date.now() + 365 * 24 * 3600_000).toISOString());
  // O botão só libera quando está tudo certo; enquanto não, a frase abaixo diz o que falta.
  const blocker =
    planId === "" ? "Escolha o plano."
    : visit === "" || Number.isNaN(visitMs) ? "Informe a data e a hora da visita."
    : dateChanged && visitMs < Date.now() - 24 * 3600_000 ? "A data da visita já passou. Escolha hoje ou uma data futura."
    : dateChanged && visitMs > Date.now() + 366 * 24 * 3600_000 ? "A data da visita está longe demais (máximo de um ano)."
    : tech.trim().length < 2 ? "Informe o técnico responsável."
    : needsAddress ? addressProblem(addr)
    : null;
  const valid = blocker === null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.saveCliente(reservation.id, {
        planId,
        nickname: nickname.trim() || null,
        // O navegador devolve hora local sem fuso; vira instante com o fuso do aparelho.
        visitAt: new Date(visit).toISOString(),
        technician: tech.trim(),
        ...(needsAddress ? { endereco: addressPayload(addr) } : {}),
      });
      clearDraft();
      clearAddr();
      say("Dados do cliente salvos");
      onSaved();
    } catch (err) {
      say(err instanceof Error ? err.message : "Falha ao salvar.", "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="ch">
        <div>
          <h3>Dados do cliente</h3>
          <small className="mono">{reservation.ctoName}</small>
        </div>
        <button type="button" className="btn sec sm" onClick={onClose}>Fechar</button>
      </div>
      <div className="summary">
        <div className="g2">
          <label className="fld">
            <span>Plano</span>
            <select value={planId} onChange={(e) => setPlanId(e.target.value)} required>
              <option value="">Escolha o plano…</option>
              {plans?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="fld">
            <span>Apelido do cliente (opcional)</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={120} placeholder="ex.: Casa do Zé" />
            <small>Só para você achar o cliente no portal. Não vai para o Voalle.</small>
          </label>
          <label className="fld">
            <span>Data e hora da visita</span>
            <input type="datetime-local" value={visit} min={dateChanged || !reservation.visitAt ? minVisit : undefined} max={maxVisit} onChange={(e) => setVisit(e.target.value)} required />
          </label>
          <label className="fld">
            <span>Técnico responsável</span>
            <input value={tech} onChange={(e) => setTech(e.target.value)} list="rn-techs" maxLength={120} placeholder="nome do técnico" required />
            <datalist id="rn-techs">{techs.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
        </div>
        {needsAddress && (
          <>
            <div className="fld" style={{ marginTop: 8 }}>
              <span>Endereço da instalação</span>
              <small>Usado para criar o contrato. O número do contrato e o login PPPoE nascem sozinhos.</small>
            </div>
            <AddressFields value={addr} onChange={setAddr} />
          </>
        )}
        <div className="acts2"><button className="btn" disabled={!valid || busy}>{busy ? "Salvando…" : "Salvar"}</button></div>
        {blocker && <p className="hint">{blocker}</p>}
      </div>
    </form>
  );
}
