import { useCallback, useEffect, useState } from "react";
import { api, request, type AdminPartner } from "../api";
import { useToast } from "./Toast";

interface CtoLimit {
  id: string;
  partnerId: string | null;
  partnerName: string | null;
  ctoId: string;
  maxPct: number;
  reason: string;
  createdAt: string;
}

const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

/**
 * Limite de ocupação por CTO: vale no lugar do percentual do parceiro naquela caixa. 100% libera um parceiro caso a caso;
 * 0% fecha a CTO para ele. Sem parceiro escolhido, a regra vale para todos. Tudo fica na auditoria, com o motivo.
 */
export function CtoLimitsCard() {
  const say = useToast();
  const [limits, setLimits] = useState<CtoLimit[] | null>(null);
  const [partners, setPartners] = useState<AdminPartner[]>([]);
  const [form, setForm] = useState({ partnerId: "", ctoId: "", maxPct: "100", reason: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    request<{ limits: CtoLimit[] }>("GET", "/admin/cto-limits").then((r) => setLimits(r.limits)).catch(() => setLimits([]));
  }, []);
  useEffect(() => {
    load();
    api.adminPartners().then((r) => setPartners(r.partners)).catch(() => setPartners([]));
  }, [load]);

  const pct = Number(form.maxPct);
  const valid = form.ctoId.trim() !== "" && Number.isInteger(pct) && pct >= 0 && pct <= 100 && form.reason.trim().length >= 5;

  async function save() {
    setBusy(true);
    try {
      await request("PUT", "/admin/cto-limits", { partnerId: form.partnerId || null, ctoId: form.ctoId.trim(), maxPct: pct, reason: form.reason.trim() });
      setForm({ partnerId: form.partnerId, ctoId: "", maxPct: "100", reason: "" });
      say("Regra salva");
      load();
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await request("DELETE", `/admin/cto-limits/${id}`);
      say("Regra removida");
      load();
    } catch (e) {
      say(errMsg(e, "Falha ao remover."), "bad");
    }
  }

  return (
    <div className="card">
      <div className="ch"><h3>Limite por CTO</h3><small>no lugar do percentual do parceiro naquela caixa</small></div>
      <div className="summary" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="fld" style={{ minWidth: 200 }}>
            <span>Parceiro</span>
            <select value={form.partnerId} onChange={(e) => setForm({ ...form, partnerId: e.target.value })}>
              <option value="">Todos os parceiros</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="fld" style={{ width: 150 }}>
            <span>CTO (id)</span>
            <input value={form.ctoId} onChange={(e) => setForm({ ...form, ctoId: e.target.value })} placeholder="24109" maxLength={60} />
          </label>
          <label className="fld" style={{ width: 110 }}>
            <span>Máximo (%)</span>
            <input value={form.maxPct} onChange={(e) => setForm({ ...form, maxPct: e.target.value.replace(/\D/g, "") })} inputMode="numeric" />
          </label>
          <label className="fld" style={{ flex: 1, minWidth: 220 }}>
            <span>Motivo</span>
            <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={300} placeholder="ex.: liberada caso a caso" />
          </label>
          <button className="btn sm" disabled={!valid || busy} onClick={() => void save()}>Salvar regra</button>
        </div>
        {limits === null ? (
          <p className="muted" style={{ margin: 0 }}>Carregando…</p>
        ) : limits.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nenhuma regra. Vale o percentual de cada parceiro.</p>
        ) : (
          <table className="hist">
            <thead><tr><th>CTO</th><th>Parceiro</th><th style={{ textAlign: "right" }}>Máx.</th><th>Motivo</th><th /></tr></thead>
            <tbody>
              {limits.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.ctoId}</td>
                  <td style={{ fontFamily: "var(--font)" }}>{l.partnerName ?? "Todos"}</td>
                  <td className="tab">{l.maxPct}%</td>
                  <td style={{ fontFamily: "var(--font)" }}>{l.reason}</td>
                  <td><button className="linkbtn" onClick={() => void remove(l.id)}>Remover</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
