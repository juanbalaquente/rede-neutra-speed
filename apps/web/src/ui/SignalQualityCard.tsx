import { useEffect, useState } from "react";
import { ApiError, request } from "../api";

interface ClientSignal {
  reservationId: string;
  contract: string | null;
  nickname: string | null;
  login: string;
  mediaDbm: number | null;
  ultimoDbm: number | null;
  piorDbm: number | null;
  minimoDbm: number;
  quedas: number;
}

interface Quality {
  days: number;
  atualizadoEm: string;
  totais: { clientes: number; comLeitura: number; semLeitura: number; mediaBaseDbm: number | null; abaixoDoMinimo: number; quedas: number; comQueda: number };
  maisQuedas: ClientSignal[];
  abaixoDoMinimo: ClientSignal[];
}

const dbm = (n: number | null) => (n === null ? "—" : `${n.toFixed(1).replace(".", ",")} dBm`);
const who = (c: ClientSignal) => `${c.contract ?? c.login}${c.nickname ? ` · ${c.nickname}` : ""}`;

/** Qualidade média do sinal da base do parceiro e quem merece atenção (mais quedas, abaixo do mínimo). Só o supervisor vê. */
export function SignalQualityCard({ onOpen }: { onOpen: (installationId: string) => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Quality | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    request<Quality>("GET", `/dashboard/sinal?days=${days}`)
      .then((r) => alive && setData(r))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.code === "status_desligado") setOff(true);
        else setError(e instanceof Error ? e.message : "Falha ao carregar.");
      });
    return () => { alive = false; };
  }, [days]);

  // Recurso desligado: o painel fica como estava, sem aviso de erro.
  if (off) return null;
  const t = data?.totais;

  return (
    <div className="card">
      <div className="ch">
        <h3>Qualidade do sinal da base</h3>
        <div className="seg" role="tablist" aria-label="Período" style={{ margin: 0 }}>
          {[7, 30, 90].map((d) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} dias</button>)}
        </div>
      </div>
      <div className="summary" style={{ display: "grid", gap: 12 }}>
        {error && <p className="error">{error}</p>}
        {!error && !data && <p className="muted" style={{ margin: 0 }}>Lendo o histórico dos clientes…</p>}
        {data && t && (
          t.clientes === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nenhum cliente instalado ainda.</p>
          ) : (
            <>
              <div className="regmap-kpis">
                <div><b>{dbm(t.mediaBaseDbm)}</b><small>sinal médio da base</small></div>
                <div><b style={t.abaixoDoMinimo ? { color: "var(--warn)" } : undefined}>{t.abaixoDoMinimo}</b><small>abaixo do mínimo aceitável</small></div>
                <div><b>{t.comQueda}</b><small>com queda no período ({t.quedas} no total)</small></div>
                {t.semLeitura > 0 && <div><b>{t.semLeitura}</b><small>sem leitura</small></div>}
              </div>
              {data.maisQuedas.length > 0 && (
                <div>
                  <b style={{ fontWeight: 500 }}>Clientes com mais quedas</b>
                  <table className="hist">
                    <tbody>
                      {data.maisQuedas.map((c) => (
                        <tr key={c.reservationId}>
                          <td style={{ fontFamily: "var(--font)" }}><button className="rowbtn" onClick={() => onOpen(c.reservationId)}>{who(c)}</button></td>
                          <td className="tab">{c.quedas} queda{c.quedas > 1 ? "s" : ""}</td>
                          <td className="tab">média {dbm(c.mediaDbm)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.abaixoDoMinimo.length > 0 && (
                <div>
                  <b style={{ fontWeight: 500 }}>Abaixo do mínimo aceitável</b>
                  <table className="hist">
                    <tbody>
                      {data.abaixoDoMinimo.map((c) => (
                        <tr key={c.reservationId}>
                          <td style={{ fontFamily: "var(--font)" }}><button className="rowbtn" onClick={() => onOpen(c.reservationId)}>{who(c)}</button></td>
                          <td className="tab" style={{ color: "var(--warn)" }}>{dbm(c.ultimoDbm)}</td>
                          <td className="tab">mínimo {dbm(c.minimoDbm)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.maisQuedas.length === 0 && data.abaixoDoMinimo.length === 0 && <p className="muted" style={{ margin: 0 }}>Nenhum cliente com queda ou sinal abaixo do mínimo no período.</p>}
            </>
          )
        )}
      </div>
    </div>
  );
}
