import { useEffect, useState } from "react";
import { request } from "../api";

interface Billing {
  month: string;
  totalCents: number;
  totalPortas: number;
  parceiros: { partnerId: string; name: string; code: string | null; cnpj: string; status: string; portas: number; canceladasNoMes: number; valorCents: number }[];
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pad = (n: number) => String(n).padStart(2, "0");
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const shift = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const d = new Date(y, mo - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const title = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const s = new Date(y, mo - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * Cobrança da Speed por parceiro: o contrato no Voalle não tem valor, então o parceiro paga direto à Speed por este
 * fechamento (portas ativas em algum momento do mês × valor fixo do plano). O demonstrativo de cada um sai em planilha.
 */
export function SpeedBillingCard() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    request<Billing>("GET", `/admin/cobranca?month=${month}`)
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Falha ao carregar."));
    return () => { alive = false; };
  }, [month]);

  return (
    <div className="card">
      <div className="ch">
        <div><h3>Cobrança dos parceiros</h3><small>fora do ERP: o contrato no Voalle não tem valor</small></div>
        <div className="ag-nav">
          <button className="btn sec sm" onClick={() => setMonth(shift(month, -1))} aria-label="Mês anterior">‹</button>
          <b style={{ minWidth: 130, textAlign: "center" }}>{title(month)}</b>
          <button className="btn sec sm" onClick={() => setMonth(shift(month, 1))} aria-label="Próximo mês" disabled={month >= thisMonth()}>›</button>
        </div>
      </div>
      {error ? (
        <p className="error" style={{ padding: "0 18px 14px" }}>{error}</p>
      ) : !data ? (
        <p className="empty">Carregando…</p>
      ) : (
        <table className="hist">
          <thead>
            <tr><th>Parceiro</th><th>CNPJ</th><th style={{ textAlign: "right" }}>Portas cobradas</th><th style={{ textAlign: "right" }}>Valor</th><th /></tr>
          </thead>
          <tbody>
            {data.parceiros.map((p) => (
              <tr key={p.partnerId}>
                <td style={{ fontFamily: "var(--font)" }}>{p.name}{p.code ? <span className="muted"> · {p.code}</span> : null}{p.status !== "ativo" ? <span className="badge b-bad" style={{ marginLeft: 8 }}>{p.status}</span> : null}</td>
                <td className="mono">{p.cnpj}</td>
                <td className="tab">{p.portas}{p.canceladasNoMes ? <span className="muted"> ({p.canceladasNoMes} cancelada{p.canceladasNoMes > 1 ? "s" : ""} no mês)</span> : null}</td>
                <td className="tab">{brl(p.valorCents)}</td>
                <td>{p.portas > 0 && <a className="linkbtn" href={`/api/admin/cobranca/${p.partnerId}/export?month=${month}`}>Demonstrativo</a>}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontFamily: "var(--font)" }}><b>Total</b></td>
              <td />
              <td className="tab"><b>{data.totalPortas}</b></td>
              <td className="tab"><b>{brl(data.totalCents)}</b></td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
