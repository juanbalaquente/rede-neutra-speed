import { useEffect, useState } from "react";
import { ApiError, api, type Dashboard, type User } from "../api";
import { clientStatusApi, type Fleet } from "../clientStatusApi";
import { BarChart } from "../ui/BarChart";
import { SignalQualityCard } from "../ui/SignalQualityCard";
import { useToast } from "../ui/Toast";

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const monthLabel = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m;

const ALARM = { fibra_loss: "Sem sinal", fibra_offline: "Offline", sem_energia: "Sem energia", pppoe_caido: "PPPoE caído" } as const;

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

/** Painel do parceiro: o que está acontecendo na operação dele hoje. */
export function PartnerDashboardPage({ user, onGo }: { user: User; onGo: (tab: "reservas" | "instalacoes" | "agenda" | "financeiro" | "chamados", installationId?: string) => void }) {
  const say = useToast();
  const [d, setD] = useState<Dashboard | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [fleetOff, setFleetOff] = useState(false);
  const [fleetErr, setFleetErr] = useState<string | null>(null);

  useEffect(() => {
    api.dashboard().then(setD).catch((e) => say(e instanceof Error ? e.message : "Falha ao carregar o painel.", "bad"));
  }, [say]);

  useEffect(() => {
    clientStatusApi.fleet().then(setFleet).catch((e) => {
      if (e instanceof ApiError && e.code === "status_desligado") setFleetOff(true);
      else setFleetErr(e instanceof Error ? e.message : "Falha ao consultar a rede.");
    });
  }, []);

  const first = user.name.split(/\s+/)[0];
  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>{greeting()}, {first}</h1>
          <p>O que está acontecendo na sua operação na rede neutra.</p>
        </div>
      </div>

      {d === null ? (
        <p className="muted">Carregando…</p>
      ) : (
        <>
          <div className="kpis kpis-6">
            <div className="card kpi"><span>Portas ativas</span><b>{d.portasAtivas}</b><small>base do que você paga</small></div>
            <div className="card kpi"><span>Instalações no mês</span><b>{d.instalacoesNoMes}</b><small>O.S. fechadas</small></div>
            <button className="card kpi kpi-btn" onClick={() => onGo("instalacoes")}><span>O.S. pendentes</span><b>{d.osPendentes}</b><small>ONU liberada, falta fechar</small></button>
            <button className="card kpi kpi-btn" onClick={() => onGo("reservas")}><span>Reservas abertas</span><b>{d.reservasAbertas}</b><small>guardando vaga</small></button>
            <button className="card kpi kpi-btn" onClick={() => onGo("agenda")}><span>Visitas hoje</span><b>{d.visitasHoje}</b><small>na agenda</small></button>
            <button className={`card kpi kpi-btn ${d.chamadosAtrasados ? "alert" : ""}`} onClick={() => onGo("chamados")}><span>Chamados abertos</span><b>{d.chamadosAbertos}</b><small>{d.chamadosAtrasados ? `${d.chamadosAtrasados} fora do prazo` : "dentro do prazo"}</small></button>
            <button className={`card kpi kpi-btn ${d.visitasAtrasadas ? "alert" : ""}`} onClick={() => onGo("agenda")}><span>Visitas atrasadas</span><b>{d.visitasAtrasadas}</b><small>{d.visitasAtrasadas ? "passaram do dia sem fechar" : "nenhuma atrasada"}</small></button>
          </div>

          {user.role === "supervisor" && <SignalQualityCard onOpen={(id) => onGo("instalacoes", id)} />}

          <div className="g11">
            <BarChart title="Instalações por mês" unit="Instalações" bars={d.serie.map((s) => ({ label: monthLabel(s.month), value: s.instalacoes }))} />
            <BarChart title="Portas ativas no fim do mês" unit="Portas ativas" bars={d.serie.map((s) => ({ label: monthLabel(s.month), value: s.ativasNoFim }))} />
          </div>

          <div className="g11">
            <div className="card">
              <div className="ch"><h3>Portas ativas por plano</h3></div>
              {d.planos.length === 0 ? (
                <p className="empty">Nenhuma porta ativa ainda.</p>
              ) : (
                <table className="hist">
                  <tbody>
                    {d.planos.map((p) => (
                      <tr key={p.plano}>
                        <td style={{ fontFamily: "var(--font)" }}>{p.plano}</td>
                        <td style={{ width: "50%" }}><span className="pbar"><i style={{ width: `${(p.qtd / d.planos[0]!.qtd) * 100}%` }} /></span></td>
                        <td className="tab">{p.qtd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="card">
              <div className="ch"><h3>Estado da rede dos seus clientes</h3>{fleet?.atualizadoEm && <small>dado de {new Date(fleet.atualizadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>}</div>
              <div className="summary">
                {fleetOff || (!fleet && !fleetErr) ? (
                  <p className="muted" style={{ margin: 0 }}>{fleetOff ? "Fibra online e PPPoE conectado, lado a lado, aparecem aqui quando a integração com a rede da Speed estiver ligada." : "Consultando a rede…"}</p>
                ) : fleetErr ? (
                  <p className="error">{fleetErr}</p>
                ) : fleet && fleet.total === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>Nenhum cliente com a O.S. fechada ainda.</p>
                ) : fleet ? (
                  <>
                    <div className="fleet">
                      <div><b>{fleet.fibraOnline}</b><small>de {fleet.total} com fibra online</small><span className="pbar"><i style={{ width: `${(fleet.fibraOnline / fleet.total) * 100}%` }} /></span></div>
                      <div><b>{fleet.pppoeConectado}</b><small>de {fleet.total} com PPPoE conectado</small><span className="pbar"><i style={{ width: `${(fleet.pppoeConectado / fleet.total) * 100}%` }} /></span></div>
                    </div>
                    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                      {[fleet.loss ? `${fleet.loss} sem sinal` : null, fleet.offline ? `${fleet.offline} offline` : null, fleet.bloqueados ? `${fleet.bloqueados} bloqueado${fleet.bloqueados > 1 ? "s" : ""}` : null, fleet.semDados ? `${fleet.semDados} sem leitura` : null].filter(Boolean).join(" · ") || "Nenhum problema nos clientes."}
                    </p>
                    {fleet.alarmes.length > 0 && (
                      <ul className="alarms">
                        {fleet.alarmes.slice(0, 5).map((a) => (
                          <li key={a.reservationId}>
                            <button className="rowbtn" onClick={() => onGo("instalacoes", a.reservationId)}>{a.contract ?? a.login}{a.nickname ? ` · ${a.nickname}` : ""}</button>
                            <span className="badge b-bad">{ALARM[a.motivo]}</span>
                          </li>
                        ))}
                        {fleet.alarmes.length > 5 && <li className="muted">e mais {fleet.alarmes.length - 5}</li>}
                      </ul>
                    )}
                  </>
                ) : null}
                {user.role === "supervisor" && <div><button className="btn sec sm" onClick={() => onGo("financeiro")}>Ver o financeiro</button></div>}
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
