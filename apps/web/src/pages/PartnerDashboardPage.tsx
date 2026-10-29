import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type Dashboard, type Finance, type User } from "../api";
import { clientStatusApi, type Fleet } from "../clientStatusApi";
import { brl } from "../money";
import { AreaChart, CardHead, Donut, HBars, monthShort, trimLeading } from "../ui/charts";
import { SignalQualityCard } from "../ui/SignalQualityCard";
import { useToast } from "../ui/Toast";

type Tab = "viabilidade" | "reservas" | "instalacoes" | "agenda" | "financeiro" | "chamados";

const ALARM = { fibra_loss: "Sem sinal", fibra_offline: "Offline", sem_energia: "Sem energia", pppoe_caido: "PPPoE caído" } as const;
const GO_LABEL: Record<Tab, string> = { viabilidade: "Abrir", reservas: "Ver reserva", instalacoes: "Abrir", agenda: "Ver agenda", financeiro: "Abrir", chamados: "Ver chamados" };

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Painel do parceiro: o que fazer agora, como está a base e quanto custa e rende o mês. */
export function PartnerDashboardPage({ user, onGo }: { user: User; onGo: (tab: Tab, installationId?: string) => void }) {
  const say = useToast();
  const [d, setD] = useState<Dashboard | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [fleetOff, setFleetOff] = useState(false);
  const [fleetErr, setFleetErr] = useState<string | null>(null);
  const [fin, setFin] = useState<Finance | null>(null);
  const supervisor = user.role === "supervisor";

  useEffect(() => {
    api.dashboard().then(setD).catch((e) => say(e instanceof Error ? e.message : "Falha ao carregar o painel.", "bad"));
  }, [say]);

  useEffect(() => {
    clientStatusApi.fleet().then(setFleet).catch((e) => {
      if (e instanceof ApiError && e.code === "status_desligado") setFleetOff(true);
      else setFleetErr(e instanceof Error ? e.message : "Falha ao consultar a rede.");
    });
  }, []);

  useEffect(() => {
    if (supervisor) api.finance(thisMonth(), {}).then(setFin).catch(() => setFin(null));
  }, [supervisor]);

  // Lista única do que pede ação: o que o servidor sabe (visitas, reservas, chamados, O.S.) mais os clientes em alarme.
  const agora = useMemo(() => {
    if (!d) return [];
    const alarms = (fleet?.alarmes ?? []).slice(0, 5).map((a) => ({
      id: `alarme-${a.reservationId}`,
      tone: "bad" as const,
      label: ALARM[a.motivo],
      text: `${a.contract ?? a.login}${a.nickname ? ` · ${a.nickname}` : ""}`,
      go: "instalacoes" as const,
      reservationId: a.reservationId,
    }));
    // Visitas atrasadas viram uma linha só quando são muitas, para não encobrir o resto da lista.
    const late = d.agora.filter((a) => a.label === "Visita atrasada");
    const others = d.agora.filter((a) => a.label !== "Visita atrasada");
    const lateRows = late.length > 2 ? [{ id: "visitas", tone: "bad" as const, label: "Visitas atrasadas", text: `${late.length} visitas passaram do dia sem fechar, a mais antiga é ${late[0]!.text}`, go: "agenda" as const, reservationId: undefined }] : late;
    const rank = (x: { tone: string }) => (x.tone === "bad" ? 0 : 1);
    return [...lateRows, ...others, ...alarms].sort((a, b) => rank(a) - rank(b));
  }, [d, fleet]);

  const first = user.name.split(/\s+/)[0];
  const porta = d ? trimLeading(d.serie, (s) => s.ativasNoFim > 0 || s.instalacoes > 0) : [];
  const deltaPortas = d && d.serie.length >= 2 ? d.serie[d.serie.length - 1]!.ativasNoFim - d.serie[d.serie.length - 2]!.ativasNoFim : 0;
  const novo = d !== null && d.portasAtivas === 0 && d.reservasAbertas === 0 && d.instalacoesNoMes === 0 && d.osPendentes === 0;
  const semPreco = fin?.resumo.semPreco ?? 0;

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
          {novo && (
            <div className="card">
              <CardHead title="Comece pela primeira venda" />
              <div className="summary">
                <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
                  <li>Consulte o endereço do cliente e veja as CTOs com vaga.</li>
                  <li>Reserve a vaga (ela fica guardada por 48 horas).</li>
                  <li>Preencha plano, visita e técnico, e crie o contrato.</li>
                  <li>No dia da visita, libere a ONU, envie as fotos e feche a O.S.</li>
                </ol>
                <div><button className="btn" onClick={() => onGo("viabilidade")}>Fazer a primeira venda</button></div>
              </div>
            </div>
          )}

          <div className="card">
            <CardHead title="Precisa de você agora" note={agora.length ? `${agora.length} ${agora.length === 1 ? "item" : "itens"}` : undefined} />
            {agora.length === 0 ? (
              <div className="now-ok"><i />Tudo em dia. Nenhuma visita, reserva, chamado ou cliente pedindo atenção.</div>
            ) : (
              <div className="now">
                {agora.slice(0, 8).map((a) => (
                  <div key={a.id} className="now-row">
                    <span className={`badge ${a.tone === "bad" ? "b-bad" : "b-warn"}`}>{a.label}</span>
                    <span className="nt">{a.text}</span>
                    <button className="btn sec sm" onClick={() => onGo(a.go, a.reservationId)}>{GO_LABEL[a.go]}</button>
                  </div>
                ))}
                {agora.length > 8 && <div className="now-row"><span /><span className="nl">e mais {agora.length - 8}</span><span /></div>}
              </div>
            )}
          </div>

          <div className="hero">
            <div className="card">
              <CardHead title="Portas ativas" note={porta.length > 0 ? `desde ${monthShort(porta[0]!.month)}` : undefined} />
              <div className="stat3">
                <div>
                  <span>Hoje</span>
                  <b>{d.portasAtivas}</b>
                  <small className={deltaPortas > 0 ? "delta-up" : deltaPortas < 0 ? "delta-down" : ""}>{deltaPortas === 0 ? "sem variação no mês" : `${deltaPortas > 0 ? "+" : ""}${deltaPortas} contra o mês anterior`}</small>
                </div>
                <div><span>Instaladas no mês</span><b>{d.instalacoesNoMes}</b><small>O.S. fechadas</small></div>
                <div><span>Reservas abertas</span><b>{d.reservasAbertas}</b><small>guardando vaga</small></div>
              </div>
              <AreaChart points={porta.map((s) => ({ label: monthShort(s.month), value: s.ativasNoFim }))} unit="Portas ativas" />
            </div>

            <div className="card">
              <CardHead title="Saúde da base" note={fleet?.atualizadoEm ? `dado de ${new Date(fleet.atualizadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : undefined} />
              <div className="summary">
                {fleetOff ? (
                  <p className="muted" style={{ margin: 0 }}>Fibra online e PPPoE conectado aparecem aqui quando a integração com a rede da Speed estiver ligada.</p>
                ) : fleetErr ? (
                  <p className="error">{fleetErr}</p>
                ) : !fleet ? (
                  <p className="muted" style={{ margin: 0 }}>Consultando a rede…</p>
                ) : fleet.total === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>Nenhum cliente com a O.S. fechada ainda.</p>
                ) : (
                  <>
                    <Donut
                      centerLabel="saudável"
                      slices={[
                        { label: "Online", value: fleet.fibraOnline, color: "var(--c-ok)", onClick: () => onGo("instalacoes") },
                        { label: "Sem sinal", value: fleet.loss, color: "var(--c-bad)", onClick: fleet.loss ? () => onGo("instalacoes") : undefined },
                        { label: "Offline", value: fleet.offline, color: "var(--c-warn)", onClick: fleet.offline ? () => onGo("instalacoes") : undefined },
                        { label: "Bloqueados", value: fleet.bloqueados, color: "var(--series-1)", onClick: fleet.bloqueados ? () => onGo("instalacoes") : undefined },
                        { label: "Sem leitura", value: fleet.semDados, color: "var(--viz-axis)" },
                      ]}
                    />
                    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                      {fleet.pppoeConectado} de {fleet.total} com PPPoE conectado.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {supervisor && (
            <div className="card">
              <CardHead title="Este mês" note="quanto você paga à Speed e quanto sobra" right={<button className="btn sec sm" onClick={() => onGo("financeiro")}>Abrir o financeiro</button>} />
              {fin === null ? (
                <p className="empty">Carregando…</p>
              ) : semPreco > 0 ? (
                <div className="stat3">
                  <div><span>Você paga à Speed</span><b>{brl(fin.resumo.custoCents)}</b><small>{fin.resumo.portasAtivas} {fin.resumo.portasAtivas === 1 ? "porta cobrada" : "portas cobradas"}</small></div>
                  <div style={{ gridColumn: "span 2" }}><span>Seu faturamento e lucro</span><b style={{ fontSize: 16, whiteSpace: "normal" }}>Cadastre o preço de venda dos planos para ver o lucro</b><small><button className="linkbtn" style={{ padding: 0 }} onClick={() => onGo("financeiro")}>Cadastrar preços</button></small></div>
                </div>
              ) : (
                <div className="stat3">
                  <div><span>Você paga à Speed</span><b>{brl(fin.resumo.custoCents)}</b><small>{fin.resumo.portasAtivas} {fin.resumo.portasAtivas === 1 ? "porta cobrada" : "portas cobradas"}</small></div>
                  <div><span>Você fatura</span><b>{brl(fin.resumo.faturamentoCents)}</b><small>{brl(fin.resumo.recebidoCents)} já recebido</small></div>
                  <div><span>Sobra</span><b className={fin.resumo.lucroCents < 0 ? "delta-down" : "delta-up"}>{brl(fin.resumo.lucroCents)}</b><small>faturamento menos custo</small></div>
                </div>
              )}
              <div style={{ height: 14 }} />
            </div>
          )}

          <div className="g11">
            <div className="card">
              <CardHead title="Do endereço à instalação" note="últimos 30 dias" />
              <div className="summary">
                {d.funil.consultas === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>Nenhuma consulta de endereço nos últimos 30 dias.</p>
                ) : (
                  <>
                    <HBars
                      max={d.funil.consultas}
                      rows={[
                        { label: "Consultas", value: d.funil.consultas, display: String(d.funil.consultas) },
                        { label: "Com vaga", value: d.funil.comVaga, display: `${d.funil.comVaga} · ${Math.round((d.funil.comVaga / d.funil.consultas) * 100)}%` },
                        { label: "Reservas", value: d.funil.reservas, display: `${d.funil.reservas} · ${Math.round((d.funil.reservas / d.funil.consultas) * 100)}%` },
                        { label: "Contratos", value: d.funil.contratos, display: `${d.funil.contratos} · ${Math.round((d.funil.contratos / d.funil.consultas) * 100)}%` },
                        { label: "O.S. fechadas", value: d.funil.osFechadas, display: `${d.funil.osFechadas} · ${Math.round((d.funil.osFechadas / d.funil.consultas) * 100)}%`, color: "var(--c-ok)" },
                      ]}
                    />
                    {d.funil.consultas - d.funil.comVaga > 0 && (
                      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                        {d.funil.consultas - d.funil.comVaga} {d.funil.consultas - d.funil.comVaga === 1 ? "consulta não tinha" : "consultas não tinham"} vaga. A Speed vê essa demanda para decidir onde ampliar a rede.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="card">
              <CardHead title="Portas ativas por plano" />
              <div className="summary">
                {d.planos.length === 0 ? (
                  <p className="empty" style={{ padding: 0 }}>Nenhuma porta ativa ainda.</p>
                ) : (
                  <HBars rows={d.planos.map((p) => ({ label: p.plano, value: p.qtd }))} />
                )}
              </div>
            </div>
          </div>

          {supervisor && <SignalQualityCard onOpen={(id) => onGo("instalacoes", id)} />}
        </>
      )}
    </main>
  );
}
