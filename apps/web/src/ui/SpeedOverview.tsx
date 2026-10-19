import { useEffect, useState } from "react";
import { request } from "../api";
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
  kind: "nao_enviado" | "parado" | "parcial" | "aguardando_equipe" | "falhou_no_meio" | "sem_ativacao";
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
  sem_ativacao: { label: "Sem instalação há dias", hint: "Contrato criado e a ONU nunca foi liberada. Cancele no Voalle e abandone aqui." },
};

export const loadOverview = () => request<Overview>("GET", "/admin/painel/parceiros");

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dbm = (n: number) => `${n.toFixed(1).replace(".", ",")} dBm`;
const when = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/** Visão consolidada da Speed: o que cada parceiro ocupa e rende, chamados e as instalações que merecem conferência. */
export function SpeedOverview() {
  const say = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abandoning, setAbandoning] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const load = () => loadOverview().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar."));
  useEffect(() => {
    void load();
  }, []);

  async function abandon(id: string) {
    try {
      await request("POST", `/admin/contracts/${id}/abandon`, { reason: why.trim() });
      say("Contrato abandonado. Cancele-o no Voalle.");
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
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="kpis">
        <div className="card kpi"><span>Portas ativas</span><b>{t.portasAtivas}</b><small>todos os parceiros</small></div>
        <div className="card kpi"><span>Receita mensal</span><b>{brl(t.receitaMensalCents)}</b><small>valor fixo por porta ativa</small></div>
        <div className={`card kpi ${t.chamadosAtrasados ? "alert" : ""}`}><span>Chamados abertos</span><b>{t.chamadosAbertos}</b><small>{t.chamadosAtrasados ? `${t.chamadosAtrasados} fora do prazo` : "dentro do prazo"}</small></div>
        <div className={`card kpi ${t.foraDoPadrao ? "alert" : ""}`}><span>Sinal fora do padrão</span><b>{t.foraDoPadrao}</b><small>instalações abaixo do mínimo</small></div>
        <div className={`card kpi ${data.hotspots.length ? "alert" : ""}`}><span>CTOs com muitos chamados</span><b>{data.hotspots.length}</b><small>{data.hotspotRegra.minimo}+ em {data.hotspotRegra.dias} dias</small></div>
      </div>

      <div className="card">
        <div className="ch"><h3>Por parceiro</h3></div>
        {data.parceiros.length === 0 ? (
          <p className="empty">Nenhum parceiro cadastrado.</p>
        ) : (
          <table className="hist">
            <thead>
              <tr><th>Parceiro</th><th style={{ textAlign: "right" }}>Portas ativas</th><th style={{ textAlign: "right" }}>Bloqueados</th><th style={{ textAlign: "right" }}>Reservas</th><th style={{ textAlign: "right" }}>Receita/mês</th><th style={{ textAlign: "right" }}>Chamados</th><th style={{ textAlign: "right" }}>Fora do padrão</th></tr>
            </thead>
            <tbody>
              {data.parceiros.map((p) => (
                <tr key={p.partnerId}>
                  <td style={{ fontFamily: "var(--font)" }}>{p.name}{p.code ? <span className="muted"> · {p.code}</span> : null}{p.status !== "ativo" ? <span className="badge b-bad" style={{ marginLeft: 8 }}>{p.status}</span> : null}</td>
                  <td className="tab">{p.portasAtivas}</td>
                  <td className="tab">{p.bloqueados}</td>
                  <td className="tab">{p.reservasAbertas}</td>
                  <td className="tab">{brl(p.receitaMensalCents)}</td>
                  <td className="tab" style={p.chamadosAtrasados ? { color: "var(--bad)" } : undefined}>{p.chamadosAbertos}{p.chamadosAtrasados ? ` (${p.chamadosAtrasados} atrasados)` : ""}</td>
                  <td className="tab" style={p.foraDoPadrao ? { color: "var(--warn)" } : undefined}>{p.foraDoPadrao}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.contratos.length > 0 && (
        <div className="card">
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
                {abandoning === c.reservationId ? (
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
        <div className="card">
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
        <div className="card">
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
