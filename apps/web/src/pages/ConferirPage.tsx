import { useEffect, useState } from "react";
import { api, type ConferirRow } from "../api";
import { motivoLabel } from "../motivos";

const PERIODS = [7, 30, 90];

/** Administrador Speed: quais CTOs em "conferir" os parceiros mais procuram. Começa a limpeza por aqui. */
export function ConferirPage() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<ConferirRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api.conferir(days)
      .then((r) => alive && setRows(r.rows))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Falha ao carregar."));
    return () => {
      alive = false;
    };
  }, [days]);

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>CTOs para conferir</h1>
          <p>As caixas que os parceiros mais procuraram e que não puderam vender. Comece a limpar o cadastro por elas.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {PERIODS.map((p) => (
            <button key={p} className={`btn sm ${p === days ? "" : "sec"}`} onClick={() => setDays(p)}>{p} dias</button>
          ))}
          <a className="btn sec sm" href={`/api/admin/cto-conferir?format=csv&days=${days}`}>Baixar CSV</a>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!error && rows === null && <p className="muted">Carregando…</p>}
      {rows && rows.length === 0 && <p className="note">Nenhuma CTO em "conferir" nos últimos {days} dias.</p>}
      {rows && rows.length > 0 && (
        <div className="card">
          <div className="ch"><h3>{rows.length} CTOs</h3><small>ordenadas por número de consultas</small></div>
          <table className="hist">
            <thead>
              <tr><th>CTO</th><th>Consultas</th><th>Endereços</th><th>Parceiros</th><th>Motivo</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.ctoId ?? "sem-id"}-${r.name}`}>
                  <td>
                    {r.name}
                    <div className="muted" style={{ fontSize: 12 }}>id Codemaps: {r.ctoId ?? "não informado"}</div>
                  </td>
                  <td className="tab">{r.consultas}</td>
                  <td className="tab">{r.enderecos}</td>
                  <td className="tab">{r.parceiros}</td>
                  <td style={{ fontFamily: "var(--font)" }}>{r.motivos.length ? r.motivos.map(motivoLabel).join("; ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
