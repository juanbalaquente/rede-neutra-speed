import { useCallback, useEffect, useState } from "react";
import { financeQuery, api, type Finance, type FinanceFilters, type PlanPrice } from "../api";
import { brl, parseBrl } from "../money";
import { AreaChart, CardHead, HBars, PairBars, monthShort, trimLeading } from "../ui/charts";
import { useToast } from "../ui/Toast";

/** Reais inteiros nos eixos dos gráficos (R$ 1.680). */
const brl0 = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

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
  // Vender abaixo do que a Speed cobra dá prejuízo em toda porta: o botão pede confirmação (muda o rótulo).
  const belowCost = valid && cents < p.speedPriceCents;

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
          <button className="btn sm" disabled={!changed || busy} onClick={() => void save()}>{belowCost ? "Salvar mesmo assim" : "Salvar"}</button>
        </span>
        {text.trim() !== "" && !valid && <small className="error" style={{ display: "block", marginTop: 4 }}>Informe um valor a partir de R$ 1,00.</small>}
        {belowCost && <small style={{ display: "block", marginTop: 4, color: "var(--warn)" }}>Abaixo do que a Speed cobra: prejuízo de {brl(p.speedPriceCents - cents)} por porta.</small>}
      </td>
      <td className="tab num">{p.referencePriceCents === null ? "—" : brl(p.referencePriceCents)}</td>
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
  const [filters, setFilters] = useState<FinanceFilters>({});
  const [ctoText, setCtoText] = useState("");
  const [hist, setHist] = useState<{ month: string; custo: number; fat: number; portas: number }[] | null>(null);

  const load = useCallback(() => {
    api.finance(month, filters).then(setF).catch((e) => { say(errMsg(e, "Falha ao carregar o financeiro."), "bad"); setF(null); });
  }, [month, filters, say]);
  useEffect(() => {
    setF(null);
    load();
  }, [load]);
  useEffect(() => {
    api.prices().then((r) => setPrices(r.prices)).catch(() => setPrices([]));
  }, []);
  // Histórico dos últimos 6 meses (sem filtros) para o gráfico de custo e faturamento; some o que vier antes da primeira porta.
  useEffect(() => {
    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(thisMonth(), i - 5));
    Promise.all(months.map((m) => api.finance(m).then((x) => ({ month: m, custo: x.resumo.custoCents, fat: x.resumo.faturamentoCents, portas: x.resumo.portasAtivas }))))
      .then((rows) => setHist(trimLeading(rows, (x) => x.portas > 0)))
      .catch(() => setHist([]));
  }, [prices]);

  async function toggle(id: string, paid: boolean) {
    try {
      await api.markPayment(id, month, paid);
      load();
    } catch (e) {
      say(errMsg(e, "Falha ao marcar o pagamento."), "bad");
    }
  }

  const r = f?.resumo;
  const missing = (prices ?? []).filter((p) => p.salePriceCents === null);
  // Todas as portas do mês sem preço: faturamento e lucro não existem ainda (não são zero nem prejuízo).
  const allMissing = r !== undefined && r.portasAtivas > 0 && r.semPreco === r.portasAtivas;
  const anyRevenue = (hist ?? []).some((h) => h.fat > 0);
  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Financeiro</h1>
          <p>Quanto você paga à Speed, quanto fatura dos seus clientes e o que já recebeu.</p>
        </div>
        <div className="ag-nav no-print">
          <button className="btn sec sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mês anterior">‹</button>
          <b className="ag-title" style={{ minWidth: 130, textAlign: "center" }}>{monthTitle(month)}</b>
          <button className="btn sec sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Próximo mês" disabled={month >= thisMonth()}>›</button>
        </div>
      </div>

      <div className="card no-print">
        <div className="summary" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="fld" style={{ minWidth: 170 }}>
            <span>Plano</span>
            <select value={filters.planId ?? ""} onChange={(e) => setFilters({ ...filters, planId: e.target.value || undefined })}>
              <option value="">Todos</option>
              {(prices ?? []).map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
            </select>
          </label>
          <label className="fld" style={{ minWidth: 150 }}>
            <span>Situação</span>
            <select value={filters.status ?? ""} onChange={(e) => setFilters({ ...filters, status: (e.target.value || undefined) as FinanceFilters["status"] })}>
              <option value="">Todas</option>
              <option value="ativo">Contrato ativo</option>
              <option value="bloqueado">Contrato bloqueado</option>
              <option value="pago">Pago no mês</option>
              <option value="em_aberto">Em aberto no mês</option>
            </select>
          </label>
          <label className="fld" style={{ width: 170 }}>
            <span>CTO</span>
            <input value={ctoText} onChange={(e) => setCtoText(e.target.value)} onBlur={() => setFilters({ ...filters, cto: ctoText.trim() || undefined })} onKeyDown={(e) => { if (e.key === "Enter") setFilters({ ...filters, cto: ctoText.trim() || undefined }); }} placeholder="nome ou id" />
          </label>
          {(filters.planId || filters.status || filters.cto) && <button className="linkbtn" onClick={() => { setFilters({}); setCtoText(""); }}>Limpar filtros</button>}
          <button className="btn sec sm" style={{ marginLeft: "auto" }} onClick={() => window.print()}>Imprimir ou salvar em PDF</button>
        </div>
      </div>

      {(filters.planId || filters.status || filters.cto) && (
        <p className="note">Relatório filtrado: {[filters.planId ? `plano ${prices?.find((p) => p.planId === filters.planId)?.name ?? ""}` : null, filters.status ? `situação ${filters.status.replace("_", " ")}` : null, filters.cto ? `CTO "${filters.cto}"` : null].filter(Boolean).join(" · ")}. Os totais e as planilhas seguem o filtro.</p>
      )}

      {missing.length > 0 && (
        <div className="step-card no-print">
          <h3>Falta um passo: o preço de venda {missing.length === 1 ? "de 1 plano" : `de ${missing.length} planos`}</h3>
          <p>Sem ele, o faturamento e o lucro não são calculados. Preencha na tabela “Preços de venda” abaixo: {missing.map((p) => p.name).join(", ")}.</p>
          <div><a className="btn sm" href="#precos" onClick={(e) => { e.preventDefault(); document.getElementById("precos")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Cadastrar preços</a></div>
        </div>
      )}

      {r && (
        <div className="kpis kpis-6">
          <div className="card kpi"><span>Portas cobradas</span><b>{r.portasAtivas}</b><small>{r.canceladasNoMes > 0 ? `${r.ativas} ativas e ${r.canceladasNoMes} cancelada${r.canceladasNoMes > 1 ? "s" : ""} no mês (mês cheio)` : "todas ativas"}</small></div>
          <div className="card kpi"><span>Você paga à Speed</span><b>{brl(r.custoCents)}</b><small>valor fixo por porta</small></div>
          <div className="card kpi"><span>Faturamento previsto</span><b>{allMissing ? "—" : brl(r.faturamentoCents)}</b><small>{allMissing ? "falta o preço de venda" : r.semPreco ? `${r.semPreco} porta(s) sem preço` : "pelos seus preços"}</small></div>
          <div className="card kpi"><span>Lucro previsto</span><b className={!allMissing && r.lucroCents < 0 && r.semPreco === 0 ? "neg" : ""}>{allMissing ? "—" : brl(r.lucroCents)}</b><small>{allMissing ? "calculado com o preço de venda" : r.semPreco ? "incompleto: faltam preços" : "faturamento menos custo"}</small></div>
          <div className="card kpi"><span>Recebido</span><b>{brl(r.recebidoCents)}</b><small>{r.pagos} de {r.portasAtivas} clientes</small></div>
          <div className="card kpi"><span>Em aberto</span><b>{allMissing ? "—" : brl(r.emAbertoCents)}</b><small>a receber no mês</small></div>
        </div>
      )}

      {hist && hist.length > 0 && (
        <div className="card">
          <CardHead title={anyRevenue ? "Custo e faturamento por mês" : "Quanto você paga à Speed por mês"} note={anyRevenue ? "últimos meses, no seu preço de venda" : "o faturamento aparece quando você cadastrar os preços"} />
          {anyRevenue ? (
            <PairBars rows={hist.map((h) => ({ label: monthShort(h.month), a: h.custo, b: h.fat }))} aLabel="Custo com a Speed" bLabel="Faturamento" format={brl0} />
          ) : (
            <AreaChart points={hist.map((h) => ({ label: monthShort(h.month), value: h.custo }))} unit="Custo com a Speed" format={brl0} />
          )}
        </div>
      )}

      <div className="card" id="precos">
        <div className="ch">
          <h3>Preços de venda</h3>
          <small>o valor da Speed é fixo por plano</small>
        </div>
        {prices === null ? (
          <p className="empty">Carregando…</p>
        ) : (
          <table className="hist">
            <thead><tr><th>Plano</th><th className="num">Speed cobra</th><th>Você vende por (R$)</th><th className="num" title="Quanto a própria Speed cobra do cliente final nesse plano">Speed vende ao cliente</th><th className="num">Seu lucro por porta</th></tr></thead>
            <tbody>{prices.map((p) => <PriceRow key={`${p.planId}-${p.salePriceCents}`} p={p} onSaved={(next) => { setPrices(next); load(); }} />)}</tbody>
          </table>
        )}
      </div>

      {f && f.porPlano.length > 0 && (
        <div className="card">
          <CardHead title="Resultado por plano" note="qual plano dá mais margem sobre o preço de venda" />
          {f.porPlano.some((p) => p.margemPct !== null) && (
            <div className="summary">
              <HBars
                max={100}
                rows={f.porPlano.filter((p) => p.margemPct !== null).map((p) => ({ label: p.plan, value: Math.max(0, p.margemPct!), display: `${p.margemPct!.toString().replace(".", ",")}%`, color: p.margemPct! < 0 ? "var(--c-bad)" : "var(--data)", hint: `${p.qtd} porta(s) · lucro ${brl(p.lucroCents)}` }))}
              />
            </div>
          )}
          <table className="hist">
            <thead><tr><th>Plano</th><th className="num">Portas</th><th className="num">Custo</th><th className="num">Faturamento</th><th className="num">Lucro</th><th className="num">Margem</th></tr></thead>
            <tbody>
              {f.porPlano.map((p) => {
                // Sem preço de venda não há lucro: mostrar "−custo" seria um prejuízo que não existe.
                const sem = p.margemPct === null;
                return (
                  <tr key={p.planId}>
                    <td style={{ fontFamily: "var(--font)" }}>{p.plan}</td>
                    <td className="tab num">{p.qtd}</td>
                    <td className="tab num">{brl(p.custoCents)}</td>
                    <td className="tab num">{sem ? <span className="muted">sem preço</span> : brl(p.faturamentoCents)}</td>
                    <td className="tab num">{sem ? "—" : brl(p.lucroCents)}</td>
                    <td className="tab num">{sem ? "—" : `${p.margemPct!.toString().replace(".", ",")}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <div><h3>Clientes e pagamento</h3><small>marque quem pagou em {monthTitle(month).toLowerCase()}</small></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a className="btn sec sm no-print" href={`/api/finance/export?month=${month}&type=fechamento${financeQuery(filters)}`}>Fechamento (planilha)</a>
            <a className="btn sec sm no-print" href={`/api/finance/export?month=${month}&type=clientes${financeQuery(filters)}`}>Base de clientes (planilha)</a>
          </div>
        </div>
        {f && f.clientes.length > 0 && (
          <div className="summary" style={{ paddingBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
              <span><b>{f.resumo.pagos}</b> de {f.resumo.portasAtivas} clientes pagaram</span>
              <span className="muted">{allMissing ? "defina os preços para ver o valor a receber" : `${brl(f.resumo.recebidoCents)} recebido · ${brl(f.resumo.emAbertoCents)} em aberto`}</span>
            </div>
            <div className="paybar" role="img" aria-label={`${f.resumo.pagos} de ${f.resumo.portasAtivas} clientes pagaram`}><i style={{ width: `${(f.resumo.pagos / f.resumo.portasAtivas) * 100}%` }} /></div>
          </div>
        )}
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
