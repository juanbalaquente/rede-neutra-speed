import { useEffect, useState } from "react";
import { api, request, type RevenueSeries } from "../api";
import { parseBrl } from "../money";
import { AreaChart, CardHead, HBars, Sparkline, monthShort, trimLeading } from "./charts";
import { useToast } from "./Toast";

export interface Overview {
  totais: { portasAtivas: number; receitaMensalCents: number; chamadosAbertos: number; chamadosAtrasados: number; foraDoPadrao: number; aprovacoesPendentes: number; contratosComProblema: number };
  parceiros: { partnerId: string; name: string; code: string | null; status: string; portasAtivas: number; bloqueados: number; reservasAbertas: number; receitaMensalCents: number; chamadosAbertos: number; chamadosAtrasados: number; foraDoPadrao: number }[];
  foraDoPadrao: { reservationId: string; partnerName: string; contract: string | null; ctoName: string; sinalCtoDbm: number; sinalFinalDbm: number; minimoDbm: number; excessoDb: number }[];
  hotspots: { partnerId: string; partnerName: string; ctoId: string; ctoName: string | null; total: number; abertos: number; ultimoEm: string }[];
  contratos: ContractIssue[];
  hotspotRegra: { minimo: number; dias: number };
}

export interface ContractIssue {
  reservationId: string;
  partnerName: string;
  contract: string | null;
  login: string | null;
  kind: "nao_enviado" | "parado" | "parcial" | "aguardando_equipe" | "falhou_no_meio" | "sem_ativacao" | "cancelamento_pendente";
  cancelState?: string | null;
  state: string;
  steps: { nome: string; estado: string; motivo?: string | null }[];
  ageMinutes: number;
}

const ISSUE_LABEL: Record<ContractIssue["kind"], { label: string; hint: string }> = {
  nao_enviado: { label: "Pedido não enviado", hint: "A Wiki não recebeu. O parceiro pode reenviar." },
  parado: { label: "Sem terminar", hint: "A Wiki não conclui. Confira com a Wiki." },
  parcial: { label: "Parou no meio", hint: "O parceiro pode repetir; a Wiki continua de onde parou." },
  aguardando_equipe: { label: "Etapa manual", hint: "Uma etapa espera a equipe da Speed." },
  falhou_no_meio: { label: "Falhou depois de criar", hint: "Há contrato (ou parte dele) no Voalle. Conclua ou cancele lá; depois abandone aqui." },
  sem_ativacao: { label: "Sem instalação há dias", hint: "Contrato criado e a ONU nunca foi liberada. Abandone aqui: o portal pede o cancelamento à Wiki." },
  cancelamento_pendente: { label: "Cancelamento no Voalle pendente", hint: "Contrato abandonado. O Voalle não cancela por API: a equipe cancela lá (a conexão some junto) e confirma aqui." },
};

export const loadOverview = () => request<Overview>("GET", "/admin/painel/parceiros");

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dbm = (n: number) => `${n.toFixed(1).replace(".", ",")} dBm`;
const when = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/** Visão consolidada da Speed: o que cada parceiro ocupa e rende, chamados e as instalações que merecem conferência. */
export function SpeedOverview({ onGo, pedidos }: { onGo: (tab: "pedidos" | "parceiros" | "chamados") => void; pedidos: number }) {
  const say = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abandoning, setAbandoning] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [rev, setRev] = useState<RevenueSeries | null>(null);
  const [editGoal, setEditGoal] = useState(false);
  const [goalText, setGoalText] = useState("");
  const load = () => loadOverview().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar."));
  const loadRev = () => api.receita().then(setRev).catch(() => setRev(null));
  useEffect(() => {
    void load();
    void loadRev();
  }, []);

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  async function saveGoal(cents: number | null) {
    try {
      await api.setRevenueGoal(cents);
      say(cents === null ? "Meta removida" : "Meta de receita salva");
      setEditGoal(false);
      void loadRev();
    } catch (e) {
      say(e instanceof Error ? e.message : "Não foi possível salvar a meta.", "bad");
    }
  }

  async function act(path: string, ok: string) {
    try {
      await request("POST", path);
      say(ok);
      void load();
    } catch (e) {
      say(e instanceof Error ? e.message : "Não foi possível concluir.", "bad");
    }
  }

  async function abandon(id: string) {
    try {
      await request("POST", `/admin/contracts/${id}/abandon`, { reason: why.trim() });
      say("Contrato abandonado. O cancelamento no Voalle fica no painel até concluir.");
      setAbandoning(null);
      setWhy("");
      void load();
    } catch (e) {
      say(e instanceof Error ? e.message : "Não foi possível abandonar.", "bad");
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Carregando parceiros…</p>;
  const t = data.totais;
  const meses = rev ? trimLeading(rev.meses, (m) => m.portas > 0) : [];
  const atual = meses[meses.length - 1];
  const anterior = meses[meses.length - 2];
  const delta = atual && anterior ? atual.totalCents - anterior.totalCents : 0;
  const meta = rev?.metaCents ?? null;
  // Fila única do que pede ação da Speed, do mais grave ao menos grave. Cada linha leva ao detalhe.
  const fila: { id: string; tone: "bad" | "warn"; label: string; text: string; run: () => void; cta: string }[] = [
    ...(data.contratos.length ? [{ id: "contratos", tone: "bad" as const, label: "Contratos", text: `${data.contratos.length} com problema na criação no Voalle`, run: () => jump("contratos"), cta: "Ver" }] : []),
    ...(t.chamadosAtrasados ? [{ id: "atrasados", tone: "bad" as const, label: "Chamados", text: `${t.chamadosAtrasados} fora do prazo (${t.chamadosAbertos} abertos)`, run: () => onGo("chamados"), cta: "Abrir" }] : []),
    ...(pedidos ? [{ id: "pedidos", tone: "warn" as const, label: "Pedidos de vaga", text: `${pedidos} esperando a decisão da Speed`, run: () => onGo("pedidos"), cta: "Decidir" }] : []),
    ...(t.aprovacoesPendentes ? [{ id: "aprov", tone: "warn" as const, label: "Aprovações", text: `${t.aprovacoesPendentes} operação(ões) de parceiros esperando aprovação`, run: () => onGo("parceiros"), cta: "Abrir" }] : []),
    ...(data.hotspots.length ? [{ id: "hot", tone: "warn" as const, label: "CTOs", text: `${data.hotspots.length} com ${data.hotspotRegra.minimo}+ chamados em ${data.hotspotRegra.dias} dias`, run: () => jump("hotspots"), cta: "Ver" }] : []),
    ...(t.foraDoPadrao ? [{ id: "fora", tone: "warn" as const, label: "Sinal", text: `${t.foraDoPadrao} instalação(ões) abaixo do mínimo`, run: () => jump("fora"), cta: "Ver" }] : []),
  ];
  const portasPor = new Map((rev?.parceiros ?? []).map((p) => [p.partnerId, p]));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="card">
        <CardHead title="Pede ação" note={fila.length ? `${fila.length} ${fila.length === 1 ? "assunto" : "assuntos"}` : undefined} />
        {fila.length === 0 ? (
          <div className="now-ok"><i />Nada pendente. Contratos, chamados, pedidos de vaga e sinal em ordem.</div>
        ) : (
          <div className="now">
            {fila.map((f) => (
              <div key={f.id} className="now-row">
                <span className={`badge ${f.tone === "bad" ? "b-bad" : "b-warn"}`}>{f.label}</span>
                <span className="nt">{f.text}</span>
                <button className="btn sec sm" onClick={f.run}>{f.cta}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hero">
        <div className="card">
          <CardHead
            title="Receita por mês"
            note="valor fixo por porta, no fechamento do mês"
            right={
              editGoal ? (
                <span className="goal-edit">
                  <input value={goalText} onChange={(e) => setGoalText(e.target.value)} inputMode="decimal" placeholder="Meta mensal (R$)" aria-label="Meta mensal de receita em reais" />
                  <button className="btn sm" disabled={!Number.isFinite(parseBrl(goalText)) || parseBrl(goalText) < 100} onClick={() => void saveGoal(parseBrl(goalText))}>Salvar</button>
                  {meta !== null && <button className="btn sec sm" onClick={() => void saveGoal(null)}>Remover</button>}
                  <button className="btn sec sm" onClick={() => setEditGoal(false)}>Cancelar</button>
                </span>
              ) : (
                <button className="btn sec sm" onClick={() => { setGoalText(meta !== null ? (meta / 100).toFixed(2).replace(".", ",") : ""); setEditGoal(true); }}>{meta === null ? "Definir meta" : "Alterar meta"}</button>
              )
            }
          />
          <div className="stat3">
            <div>
              <span>Este mês</span>
              <b>{brl(atual?.totalCents ?? t.receitaMensalCents)}</b>
              <small className={delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : ""}>{!anterior ? "primeiro mês com portas" : delta === 0 ? "igual ao mês anterior" : `${delta > 0 ? "+" : "−"}${brl(Math.abs(delta))} contra o mês anterior`}</small>
            </div>
            <div><span>Portas ativas</span><b>{t.portasAtivas}</b><small>todos os parceiros</small></div>
            <div>
              <span>Meta</span>
              <b>{meta === null ? "—" : brl(meta)}</b>
              <small>{meta === null ? "defina para ver o quanto falta" : atual && atual.totalCents >= meta ? "meta atingida" : `faltam ${brl(meta - (atual?.totalCents ?? 0))}`}</small>
            </div>
          </div>
          {meses.length > 0 && <AreaChart points={meses.map((m) => ({ label: monthShort(m.month), value: m.totalCents }))} unit="Receita" format={(n) => brl(n)} goal={meta} />}
        </div>

        <div className="card">
          <CardHead title="Chamados e sinal" note="resumo do que está aberto" />
          <div className="summary">
            <HBars
              rows={[
                { label: "Abertos", value: t.chamadosAbertos, color: "var(--data)" },
                { label: "Fora do prazo", value: t.chamadosAtrasados, color: "var(--c-bad)" },
                { label: "Sinal fora do padrão", value: t.foraDoPadrao, color: "var(--c-warn)" },
                { label: "CTOs com muitos chamados", value: data.hotspots.length, color: "var(--c-warn)" },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <CardHead title="Parceiros" note="portas ativas nos últimos meses" />
        {data.parceiros.length === 0 ? (
          <p className="empty">Nenhum parceiro cadastrado.</p>
        ) : (
          <div className="tscroll">
            <div className="rkh"><span>Parceiro</span><span>Evolução</span><span style={{ textAlign: "right" }}>Portas</span><span style={{ textAlign: "right" }}>Receita/mês</span></div>
            {data.parceiros.map((p) => {
              const series = portasPor.get(p.partnerId);
              const ports = series ? series.portas.slice(-Math.max(3, meses.length)) : [];
              const prev = ports.length >= 2 ? ports[ports.length - 2]! : null;
              const d = prev === null ? null : p.portasAtivas - prev;
              return (
                <div key={p.partnerId} className="rk">
                  <span className="rn">
                    {p.name}{p.code ? <small>{p.code}</small> : null}
                    {p.status !== "ativo" ? <span className="badge b-bad" style={{ marginLeft: 8 }}>{p.status}</span> : null}
                    {p.bloqueados > 0 && <small>{p.bloqueados} bloqueado{p.bloqueados > 1 ? "s" : ""}</small>}
                    {p.chamadosAtrasados > 0 && <span className="badge b-bad" style={{ marginLeft: 8 }}>{p.chamadosAtrasados} atrasado{p.chamadosAtrasados > 1 ? "s" : ""}</span>}
                    {p.foraDoPadrao > 0 && <span className="badge b-warn" style={{ marginLeft: 8 }}>{p.foraDoPadrao} sinal</span>}
                  </span>
                  <Sparkline values={ports} label={`Portas ativas de ${p.name}`} />
                  <span className="tab" style={{ textAlign: "right" }}><b>{p.portasAtivas}</b>{d !== null && d !== 0 && <small className={d > 0 ? "delta-up" : "delta-down"} style={{ marginLeft: 6 }}>{d > 0 ? "+" : "−"}{Math.abs(d)}</small>}</span>
                  <span className="tab" style={{ textAlign: "right" }}>{brl(p.receitaMensalCents)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {data.contratos.length > 0 && (
        <div className="card" id="contratos">
          <div className="ch"><h3>Contratos com problema</h3><small>criação de contrato no Voalle que precisa de atenção</small></div>
          <ul className="ops" style={{ padding: "0 18px 14px" }}>
            {data.contratos.map((c) => (
              <li key={c.reservationId}>
                <div className="ops-h">
                  <b>{ISSUE_LABEL[c.kind].label}</b>
                  <span>{c.partnerName} · contrato <span className="mono">{c.contract ?? "ainda sem número"}</span>{c.login ? <> · <span className="mono">{c.login}</span></> : null}</span>
                  <small className="muted">há {c.ageMinutes >= 1440 ? `${Math.round(c.ageMinutes / 1440)} dia(s)` : c.ageMinutes >= 60 ? `${Math.round(c.ageMinutes / 60)} h` : `${c.ageMinutes} min`}</small>
                </div>
                <small className="muted">{ISSUE_LABEL[c.kind].hint}</small>
                {c.steps.length > 0 && <small className="muted">{c.steps.map((s) => `${s.nome.replace("_", " ")}: ${s.estado}${s.motivo ? ` (${s.motivo})` : ""}`).join(" · ")}</small>}
                {c.kind === "cancelamento_pendente" ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <small className="muted">Estado: {c.cancelState === "pendente_envio" ? "não chegou à Wiki" : c.cancelState === "aguardando_equipe" ? "tarefa da equipe da Speed" : c.cancelState}</small>
                    {(c.cancelState === "pendente_envio" || c.cancelState === "falhou") && <button className="btn sec sm" onClick={() => void act(`/admin/contracts/${c.reservationId}/cancel/retry`, "Cancelamento reenviado")}>Reenviar à Wiki</button>}
                    <button className="btn sm" onClick={() => void act(`/admin/contracts/${c.reservationId}/cancel/done`, "Cancelamento confirmado")}>Já cancelei no Voalle</button>
                  </div>
                ) : abandoning === c.reservationId ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Motivo do abandono (obrigatório)" maxLength={300} style={{ flex: 1, minWidth: 220, border: "1px solid var(--line2)", borderRadius: 9, padding: "8px 10px", background: "var(--surf)", color: "var(--ink)" }} />
                    <button className="btn sm" disabled={why.trim().length < 5} onClick={() => void abandon(c.reservationId)}>Abandonar e cancelar a reserva</button>
                    <button className="btn sec sm" onClick={() => { setAbandoning(null); setWhy(""); }}>Voltar</button>
                  </div>
                ) : (
                  <div><button className="btn sec sm" onClick={() => setAbandoning(c.reservationId)}>Abandonar</button></div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.hotspots.length > 0 && (
        <div className="card" id="hotspots">
          <div className="ch"><h3>CTOs com muitos chamados</h3><small>mesmo parceiro, mesma CTO: problema de infraestrutura ou instalação malfeita</small></div>
          <table className="hist">
            <thead><tr><th>CTO</th><th>Parceiro</th><th style={{ textAlign: "right" }}>Chamados</th><th style={{ textAlign: "right" }}>Abertos</th><th>Último</th></tr></thead>
            <tbody>
              {data.hotspots.map((h) => (
                <tr key={`${h.partnerId}|${h.ctoId}`}>
                  <td className="mono">{h.ctoName ?? h.ctoId}</td>
                  <td style={{ fontFamily: "var(--font)" }}>{h.partnerName}</td>
                  <td className="tab">{h.total}</td>
                  <td className="tab">{h.abertos}</td>
                  <td className="tab">{when(h.ultimoEm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.foraDoPadrao.length > 0 && (
        <div className="card" id="fora">
          <div className="ch"><h3>Instalações fora do padrão de sinal</h3><small>sinal final abaixo do medido na CTO menos o limite</small></div>
          <table className="hist">
            <thead><tr><th>Contrato</th><th>Parceiro</th><th>CTO</th><th style={{ textAlign: "right" }}>Na CTO</th><th style={{ textAlign: "right" }}>Final</th><th style={{ textAlign: "right" }}>Abaixo do mínimo</th></tr></thead>
            <tbody>
              {data.foraDoPadrao.map((o) => (
                <tr key={o.reservationId}>
                  <td className="mono">{o.contract ?? "sem contrato"}</td>
                  <td style={{ fontFamily: "var(--font)" }}>{o.partnerName}</td>
                  <td className="mono">{o.ctoName}</td>
                  <td className="tab">{dbm(o.sinalCtoDbm)}</td>
                  <td className="tab">{dbm(o.sinalFinalDbm)}</td>
                  <td className="tab" style={{ color: "var(--warn)" }}>{o.excessoDb.toFixed(1).replace(".", ",")} dB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
