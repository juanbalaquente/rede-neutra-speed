import { useEffect, useState } from "react";
import { request } from "../api";

export interface Overview {
  totais: { portasAtivas: number; receitaMensalCents: number; chamadosAbertos: number; chamadosAtrasados: number; foraDoPadrao: number };
  parceiros: { partnerId: string; name: string; code: string | null; status: string; portasAtivas: number; bloqueados: number; reservasAbertas: number; receitaMensalCents: number; chamadosAbertos: number; chamadosAtrasados: number; foraDoPadrao: number }[];
  foraDoPadrao: { reservationId: string; partnerName: string; contract: string | null; ctoName: string; sinalCtoDbm: number; sinalFinalDbm: number; minimoDbm: number; excessoDb: number }[];
  hotspots: { partnerId: string; partnerName: string; ctoId: string; ctoName: string | null; total: number; abertos: number; ultimoEm: string }[];
  hotspotRegra: { minimo: number; dias: number };
}

export const loadOverview = () => request<Overview>("GET", "/admin/painel/parceiros");

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dbm = (n: number) => `${n.toFixed(1).replace(".", ",")} dBm`;
const when = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/** Visão consolidada da Speed: o que cada parceiro ocupa e rende, chamados e as instalações que merecem conferência. */
export function SpeedOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadOverview().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Falha ao carregar."));
  }, []);

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
