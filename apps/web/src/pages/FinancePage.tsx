import { useCallback, useEffect, useState } from "react";
import { api, type Finance, type PlanPrice } from "../api";
import { brl, parseBrl } from "../money";
import { useToast } from "../ui/Toast";

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const shiftMonth = (m: string, n: number) => {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthTitle = (m: string) => {
  const t = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function PriceRow({ p, onSaved }: { p: PlanPrice; onSaved: (prices: PlanPrice[]) => void }) {
  const say = useToast();
  const [text, setText] = useState(p.salePriceCents === null ? "" : (p.salePriceCents / 100).toFixed(2).replace(".", ","));
  const [busy, setBusy] = useState(false);
  const cents = parseBrl(text);
  const valid = text.trim() !== "" && Number.isFinite(cents) && cents >= 100;
  const changed = valid && cents !== p.salePriceCents;
  const lucro = valid ? cents - p.speedPriceCents : null;

  async function save() {
    setBusy(true);
    try {
      onSaved((await api.setPrice(p.planId, cents)).prices);
      say(`Preço do ${p.name} salvo`);
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td style={{ fontFamily: "var(--font)" }}>{p.name}</td>
      <td className="tab num">{brl(p.speedPriceCents)}</td>
      <td>
        <span className="inrow">
          <input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" placeholder="0,00" aria-label={`Preço de venda do ${p.name}`} style={{ maxWidth: 120 }} />
          <button className="btn sm" disabled={!changed || busy} onClick={() => void save()}>Salvar</button>
        </span>
      </td>
      <td className="tab num">{lucro === null ? "—" : `${brl(lucro)} (${Math.round((lucro / cents) * 100)}%)`}</td>
    </tr>
  );
}

/** Financeiro do supervisor: preços de venda, custo com a Speed, faturamento, lucro e recebimento do mês. */
export function FinancePage() {
  const say = useToast();
  const [month, setMonth] = useState(thisMonth());
  const [f, setF] = useState<Finance | null>(null);
  const [prices, setPrices] = useState<PlanPrice[] | null>(null);

  const load = useCallback(() => {
    api.finance(month).then(setF).catch((e) => { say(errMsg(e, "Falha ao carregar o financeiro."), "bad"); setF(null); });
  }, [month, say]);
  useEffect(() => {
    setF(null);
    load();
  }, [load]);
  useEffect(() => {
    api.prices().then((r) => setPrices(r.prices)).catch(() => setPrices([]));
  }, []);

  async function toggle(id: string, paid: boolean) {
    try {
      await api.markPayment(id, month, paid);
      load();
    } catch (e) {
      say(errMsg(e, "Falha ao marcar o pagamento."), "bad");
    }
  }

  const r = f?.resumo;
  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Financeiro</h1>
          <p>Quanto você paga à Speed, quanto fatura dos seus clientes e o que já recebeu.</p>
        </div>
        <div className="ag-nav">
          <button className="btn sec sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mês anterior">‹</button>
          <b className="ag-title" style={{ minWidth: 130, textAlign: "center" }}>{monthTitle(month)}</b>
          <button className="btn sec sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Próximo mês" disabled={month >= thisMonth()}>›</button>
        </div>
      </div>

      {prices && prices.some((p) => p.salePriceCents === null) && (
        <p className="note">Cadastre o preço de venda de cada plano abaixo. Sem ele, o faturamento e o lucro ficam incompletos.</p>
      )}

      {r && (
        <div className="kpis kpis-6">
          <div className="card kpi"><span>Portas ativas</span><b>{r.portasAtivas}</b><small>{r.semPreco ? `${r.semPreco} sem preço de venda` : "no mês"}</small></div>
          <div className="card kpi"><span>Custo com a Speed</span><b>{brl(r.custoCents)}</b><small>por porta ativada</small></div>
          <div className="card kpi"><span>Faturamento previsto</span><b>{brl(r.faturamentoCents)}</b><small>pelos seus preços</small></div>
          <div className="card kpi"><span>Lucro previsto</span><b className={r.lucroCents < 0 ? "neg" : ""}>{brl(r.lucroCents)}</b><small>faturamento menos custo</small></div>
          <div className="card kpi"><span>Recebido</span><b>{brl(r.recebidoCents)}</b><small>{r.pagos} de {r.portasAtivas} clientes</small></div>
          <div className="card kpi"><span>Em aberto</span><b>{brl(r.emAbertoCents)}</b><small>a receber no mês</small></div>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Preços de venda</h3>
          <small>o valor da Speed é fixo por plano</small>
        </div>
        {prices === null ? (
          <p className="empty">Carregando…</p>
        ) : (
          <table className="hist">
            <thead><tr><th>Plano</th><th className="num">Speed cobra</th><th>Você vende por (R$)</th><th className="num">Seu lucro por porta</th></tr></thead>
            <tbody>{prices.map((p) => <PriceRow key={`${p.planId}-${p.salePriceCents}`} p={p} onSaved={(next) => { setPrices(next); load(); }} />)}</tbody>
          </table>
        )}
      </div>

      {f && f.porPlano.length > 0 && (
        <div className="card">
          <div className="ch"><h3>Resultado por plano</h3><small>qual plano dá mais margem</small></div>
          <table className="hist">
            <thead><tr><th>Plano</th><th className="num">Portas</th><th className="num">Custo</th><th className="num">Faturamento</th><th className="num">Lucro</th><th className="num">Margem</th></tr></thead>
            <tbody>
              {f.porPlano.map((p) => (
                <tr key={p.planId}>
                  <td style={{ fontFamily: "var(--font)" }}>{p.plan}</td>
                  <td className="tab num">{p.qtd}</td>
                  <td className="tab num">{brl(p.custoCents)}</td>
                  <td className="tab num">{brl(p.faturamentoCents)}</td>
                  <td className="tab num">{brl(p.lucroCents)}</td>
                  <td className="tab num">{p.margemPct === null ? "—" : `${p.margemPct.toString().replace(".", ",")}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <div><h3>Clientes e pagamento</h3><small>marque quem pagou em {monthTitle(month).toLowerCase()}</small></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a className="btn sec sm" href={`/api/finance/export?month=${month}&type=fechamento`}>Fechamento (planilha)</a>
            <a className="btn sec sm" href={`/api/finance/export?month=${month}&type=clientes`}>Base de clientes (planilha)</a>
          </div>
        </div>
        {f === null ? (
          <p className="empty">Carregando…</p>
        ) : f.clientes.length === 0 ? (
          <p className="empty">Nenhuma porta ativa neste mês. Uma porta passa a contar quando a O.S. é fechada.</p>
        ) : (
          <table className="hist">
            <thead><tr><th>Cliente</th><th>Plano</th><th className="num">Valor</th><th className="num">Pagamento</th></tr></thead>
            <tbody>
              {f.clientes.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontFamily: "var(--font)" }}>{c.nickname ?? "—"}<div className="muted mono" style={{ fontSize: 12 }}>{c.contract ?? "sem contrato"}</div></td>
                  <td>{c.plan}</td>
                  <td className="tab num">{c.priceCents === null ? <span className="muted">sem preço</span> : brl(c.priceCents)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className={`btn sm ${c.paid === true ? "" : "sec"}`} aria-pressed={c.paid === true} onClick={() => void toggle(c.id, true)}>Pago</button>{" "}
                    <button className={`btn sm ${c.paid === false ? "" : "sec"}`} aria-pressed={c.paid === false} onClick={() => void toggle(c.id, false)}>Não pago</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
