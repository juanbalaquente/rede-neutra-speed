import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, type AdminPartner, type PartnerLimits } from "../api";
import { useToast } from "../ui/Toast";
import { parseBrl } from "../money";
import { isValidCnpj, maskCnpj } from "../validators";
import { UsersPanel } from "../ui/UsersPanel";
import { CtoLimitsCard } from "../ui/CtoLimitsCard";
import { ApprovalsCard } from "../ui/ApprovalsCard";
import { ticketApi, type TicketType } from "../ticketsApi";
import { TICKET_LABEL } from "./TicketsPage";

/** Siglas do piloto (OLTs Backbone Central, Itacolomi e Fátima). */
const PILOT_REGIONS = ["R1", "ITA", "FAT"];
const REGION_RE = /^[A-Z0-9]{1,8}$/;
const CODE_RE = /^[A-Z0-9]{2,8}$/;
const DEFAULT_LIMITS: PartnerLimits = { maxActiveReservations: 10, maxCtoOccupancyPct: 50, maxUsers: 10 };

const fmtCnpj = (d: string) => (d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d);
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function RegionsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = (raw: string) => {
    const sigla = raw.trim().toUpperCase();
    if (!sigla) return;
    if (!REGION_RE.test(sigla)) {
      setError("Sigla de 1 a 8 letras ou números, sem espaço.");
      return;
    }
    setError(null);
    if (!value.includes(sigla)) onChange([...value, sigla]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const missingPilot = PILOT_REGIONS.filter((r) => !value.includes(r));
  return (
    <div className="fld">
      <span>Siglas liberadas</span>
      <div className="chips">
        {value.map((r) => (
          <span key={r} className="chip">
            {r}
            <button type="button" aria-label={`Remover ${r}`} onClick={() => onChange(value.filter((x) => x !== r))}>×</button>
          </span>
        ))}
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => add(text)} placeholder={value.length ? "" : "ex.: ITA"} aria-label="Adicionar sigla" />
      </div>
      {error && <small className="error">{error}</small>}
      <small>
        {value.length === 0 ? "Sem siglas, o parceiro não vê nenhuma CTO." : "Só CTOs com essas siglas no nome são oferecidas."}
        {missingPilot.length > 0 && (
          <>
            {" "}
            <button type="button" className="linkbtn" onClick={() => onChange([...value, ...missingPilot])}>Adicionar piloto ({missingPilot.join(", ")})</button>
          </>
        )}
      </small>
    </div>
  );
}

/** Código curto do provedor. O login PPPoE de cada cliente é `<contrato>-<código>`. */
function CodeField({ value, onChange, valid }: { value: string; onChange: (v: string) => void; valid: boolean }) {
  const shown = value.trim().toUpperCase();
  return (
    <label className="fld">
      <span>Código do provedor</span>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} maxLength={8} placeholder="ex.: JHV" style={{ textTransform: "uppercase", maxWidth: 160 }} />
      {!valid ? (
        <small className="error">De 2 a 8 letras ou números, sem hífen.</small>
      ) : (
        <small>{shown ? <>Login PPPoE dos clientes: <span className="mono">12345-{shown}</span></> : "Sem código, o parceiro não consegue liberar ONU."}</small>
      )}
    </label>
  );
}

function LimitsFields({ value, onChange }: { value: PartnerLimits; onChange: (v: PartnerLimits) => void }) {
  const num = (k: keyof PartnerLimits, label: string, min: number, max: number, hint: string) => (
    <label className="fld">
      <span>{label}</span>
      <input type="number" min={min} max={max} value={value[k]} onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) })} />
      <small>{hint}</small>
    </label>
  );
  return (
    <div className="g3">
      {num("maxActiveReservations", "Reservas simultâneas", 1, 1000, "abertas ao mesmo tempo")}
      {num("maxCtoOccupancyPct", "Ocupação por CTO (%)", 1, 100, "das vagas de cada CTO")}
      {num("maxUsers", "Usuários", 1, 500, "ativos no portal")}
    </div>
  );
}

function PartnerEditor({ partner, onChanged, focusUsers }: { partner: AdminPartner; onChanged: () => void; focusUsers?: boolean }) {
  const say = useToast();
  const usersRef = useRef<HTMLDivElement>(null);
  // Parceiro recém-cadastrado: o próximo passo é o supervisor, que fica no fim do painel.
  useEffect(() => {
    if (focusUsers) usersRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusUsers]);
  const [regions, setRegions] = useState(partner.allowedRegions);
  const [code, setCode] = useState(partner.code ?? "");
  const [limits, setLimits] = useState<PartnerLimits>({
    maxActiveReservations: partner.maxActiveReservations,
    maxCtoOccupancyPct: partner.maxCtoOccupancyPct,
    maxUsers: partner.maxUsers,
  });
  const [busy, setBusy] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");

  const regionsChanged = regions.join(",") !== partner.allowedRegions.join(",");
  const codeNorm = code.trim().toUpperCase();
  const codeChanged = codeNorm !== (partner.code ?? "");
  const codeValid = CODE_RE.test(codeNorm);
  const changedLimits = (Object.keys(limits) as (keyof PartnerLimits)[]).filter((k) => limits[k] !== partner[k]);
  const dirty = regionsChanged || codeChanged || changedLimits.length > 0;

  async function save() {
    setBusy(true);
    try {
      const changes: Parameters<typeof api.updatePartner>[1] = {};
      if (regionsChanged) changes.allowedRegions = regions;
      if (codeChanged) changes.code = codeNorm;
      for (const k of changedLimits) changes[k] = limits[k];
      await api.updatePartner(partner.id, changes);
      say("Alterações salvas");
      onChanged();
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: AdminPartner["status"]) {
    setBusy(true);
    try {
      await api.updatePartner(partner.id, status === "bloqueado" ? { status, reason: reason.trim() } : { status });
      say(status === "bloqueado" ? `${partner.name} bloqueado` : `${partner.name} reativado`);
      setBlocking(false);
      setReason("");
      onChanged();
    } catch (e) {
      say(errMsg(e, "Falha ao alterar."), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="card">
        <div className="ch">
          <div>
            <h3>{partner.name}</h3>
            <small className="mono">{fmtCnpj(partner.cnpj)}</small>
          </div>
          <span className={`badge ${partner.status === "ativo" ? "b-ok" : "b-bad"}`}>{partner.status === "ativo" ? "Ativo" : "Bloqueado"}</span>
        </div>
        <div className="summary">
          <CodeField value={code} onChange={setCode} valid={codeValid || code === ""} />
          <RegionsInput value={regions} onChange={setRegions} />
          <LimitsFields value={limits} onChange={setLimits} />
          <div className="acts2" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm" disabled={!dirty || busy || (codeChanged && !codeValid)} onClick={save}>{busy ? "Salvando…" : "Salvar alterações"}</button>
            {dirty && (
              <button
                className="btn sec sm"
                onClick={() => {
                  setCode(partner.code ?? "");
                  setRegions(partner.allowedRegions);
                  setLimits({ maxActiveReservations: partner.maxActiveReservations, maxCtoOccupancyPct: partner.maxCtoOccupancyPct, maxUsers: partner.maxUsers });
                }}
              >
                Descartar
              </button>
            )}
          </div>
        </div>
        <div className="summary" style={{ borderTop: "1px solid var(--line)" }}>
          {partner.status === "bloqueado" ? (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted">Os usuários deste parceiro estão sem acesso ao portal.</span>
              <button className="btn sec sm" disabled={busy} onClick={() => setStatus("ativo")}>Reativar parceiro</button>
            </div>
          ) : !blocking ? (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted">Bloquear corta o acesso de todos os usuários do parceiro na hora.</span>
              <button className="btn sec sm danger" onClick={() => setBlocking(true)}>Bloquear parceiro</button>
            </div>
          ) : (
            <div className="fld">
              <span>Motivo do bloqueio (fica na auditoria)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: inadimplência" autoFocus />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button className="btn sm danger-solid" disabled={busy || !reason.trim()} onClick={() => setStatus("bloqueado")}>Confirmar bloqueio de {partner.name}</button>
                <button className="btn sec sm" onClick={() => setBlocking(false)}>Voltar</button>
              </div>
              {!reason.trim() && <small className="muted">Escreva o motivo para liberar o botão.</small>}
            </div>
          )}
        </div>
      </div>
      <div ref={usersRef}>
        <UsersPanel partnerId={partner.id} maxUsers={partner.maxUsers} meId="" emptyHint="Nenhum usuário ainda. Cadastre o supervisor do parceiro para ele entrar no portal." />
      </div>
    </div>
  );
}

function NewPartnerForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const say = useToast();
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [code, setCode] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [busy, setBusy] = useState(false);
  const digits = cnpj.replace(/\D/g, "");
  const codeNorm = code.trim().toUpperCase();
  const codeOk = codeNorm === "" || CODE_RE.test(codeNorm);
  const cnpjOk = digits.length === 14 && isValidCnpj(digits);
  // O botão só libera quando tudo está certo; enquanto não, diz o que falta.
  const blocker = name.trim().length < 2 ? "Informe a razão social ou o nome." : digits.length !== 14 ? "Informe o CNPJ completo." : !cnpjOk ? "Confira o CNPJ: os dígitos verificadores não batem." : !codeOk ? "O código tem de 2 a 8 letras ou números, sem hífen." : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { partner } = await api.createPartner({ name: name.trim(), cnpj: digits, ...(codeNorm ? { code: codeNorm } : {}), allowedRegions: regions, ...limits });
      say(`${partner.name} cadastrado. Agora cadastre o supervisor dele.`);
      onCreated(partner.id);
    } catch (err) {
      say(errMsg(err, "Falha ao cadastrar."), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="ch"><h3>Novo parceiro</h3><small>o contrato fica no nome dele</small></div>
      <div className="summary">
        <div className="g2">
          <label className="fld"><span>Razão social ou nome</span><input value={name} onChange={(e) => setName(e.target.value)} minLength={2} required autoFocus /></label>
          <label className="fld">
            <span>CNPJ</span>
            <input value={cnpj} onChange={(e) => setCnpj(maskCnpj(e.target.value))} inputMode="numeric" placeholder="00.000.000/0000-00" required />
            {cnpj && digits.length !== 14 && <small className="error">O CNPJ tem 14 dígitos ({digits.length} agora).</small>}
            {digits.length === 14 && !cnpjOk && <small className="error">CNPJ inválido: confira os dígitos.</small>}
          </label>
        </div>
        <CodeField value={code} onChange={setCode} valid={codeOk} />
        <RegionsInput value={regions} onChange={setRegions} />
        <LimitsFields value={limits} onChange={setLimits} />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn sm" disabled={busy || blocker !== null}>{busy ? "Cadastrando…" : "Cadastrar parceiro"}</button>
          <button type="button" className="btn sec sm" onClick={onCancel}>Cancelar</button>
        </div>
        {blocker && <small className="muted">{blocker}</small>}
      </div>
    </form>
  );
}

/** Perda máxima entre o sinal medido na CTO e o da ONU. Vale para todos os parceiros; cada ativação guarda o limite que valeu. */
function SignalLimitCard() {
  const say = useToast();
  const [saved, setSaved] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.signalLimit().then((r) => { setSaved(r.limiteDb); setText(String(r.limiteDb).replace(".", ",")); }).catch(() => setSaved(null));
  }, []);
  const value = Number(text.replace(",", "."));
  const valid = Number.isFinite(value) && value >= 0.5 && value <= 6;
  async function save() {
    setBusy(true);
    try {
      const r = await api.setSignalLimit(value);
      setSaved(r.limiteDb);
      say("Limite de sinal atualizado");
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    } finally {
      setBusy(false);
    }
  }
  if (saved === null) return null;
  return (
    <div className="card">
      <div className="ch"><h3>Trava de sinal</h3><small>vale para todos os parceiros</small></div>
      <div className="summary" style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <label className="fld" style={{ width: 240 }}>
          <span>Perda máxima (dB)</span>
          <input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" />
          <small>{valid ? "Sinal na ONU pode ser no máximo isso pior que o medido na CTO." : "Entre 0,5 e 6 dB."}</small>
        </label>
        <button className="btn sm" style={{ marginTop: 26 }} disabled={busy || !valid || value === saved} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>
      </div>
    </div>
  );
}

/** Prazo de resposta da Infra por tipo de chamado. A diretoria ainda define os valores; os padrões são provisórios. */
function SlaCard() {
  const say = useToast();
  const [sla, setSla] = useState<Record<TicketType, number> | null>(null);
  const [padrao, setPadrao] = useState<Record<TicketType, number> | null>(null);
  const [draft, setDraft] = useState<Partial<Record<TicketType, string>>>({});
  useEffect(() => {
    ticketApi.sla().then((r) => { setSla(r.sla); setPadrao(r.padrao); }).catch(() => setSla(null));
  }, []);
  if (!sla || !padrao) return null;
  async function save(type: TicketType) {
    const hours = Number(draft[type]);
    try {
      setSla((await ticketApi.setSla(type, hours)).sla);
      setDraft((d) => ({ ...d, [type]: undefined }));
      say("Prazo atualizado");
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    }
  }
  return (
    <div className="card">
      <div className="ch"><h3>Prazo dos chamados</h3><small>em horas, vale para os chamados novos</small></div>
      <div className="summary" style={{ display: "grid", gap: 10 }}>
        {(Object.keys(TICKET_LABEL) as TicketType[]).map((type) => {
          const text = draft[type] ?? String(sla[type]);
          const hours = Number(text);
          const valid = Number.isInteger(hours) && hours >= 1 && hours <= 720;
          return (
            <div key={type} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ width: 240 }}>{TICKET_LABEL[type]}{sla[type] === padrao[type] ? <small className="muted"> · padrão</small> : null}</span>
              <input value={text} onChange={(e) => setDraft((d) => ({ ...d, [type]: e.target.value }))} inputMode="numeric" style={{ width: 80 }} aria-label={`Horas para ${TICKET_LABEL[type]}`} />
              <button className="btn sm" disabled={!valid || hours === sla[type]} onClick={() => void save(type)}>Salvar</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Se as fotos do checklist são obrigatórias para o técnico fechar a O.S. (o planejamento recomenda que sim). */
function OsPhotosCard() {
  const say = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    api.osPhotosRequired().then((r) => setOn(r.obrigatorias)).catch(() => setOn(null));
  }, []);
  if (on === null) return null;
  async function toggle(next: boolean) {
    try {
      setOn((await api.setOsPhotosRequired(next)).obrigatorias);
      say(next ? "Fotos obrigatórias para fechar a O.S." : "Fotos opcionais para fechar a O.S.");
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    }
  }
  return (
    <div className="card">
      <div className="ch"><h3>Fotos da O.S.</h3><small>vale para todos os parceiros</small></div>
      <div className="summary">
        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} style={{ width: "auto" }} />
          <span>Exigir as fotos do checklist para fechar a O.S.</span>
        </label>
        <small className="muted">Sem as fotos, o controle de padrão da rede fica só no papel. Desligue só se a diretoria decidir por amostragem.</small>
      </div>
    </div>
  );
}

/** O que a Speed cobra do parceiro por porta ativada, por plano. O parceiro não edita. */
function SpeedPricesCard() {
  const say = useToast();
  const [plans, setPlans] = useState<{ id: string; name: string; speedMbps: number; speedPriceCents: number }[] | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  useEffect(() => {
    api.adminPlans().then((r) => {
      setPlans(r.plans);
      setText(Object.fromEntries(r.plans.map((p) => [p.id, (p.speedPriceCents / 100).toFixed(2).replace(".", ",")])));
    }).catch(() => setPlans(null));
  }, []);
  if (!plans) return null;
  async function save(id: string, cents: number) {
    try {
      const r = await api.setSpeedPrice(id, cents);
      setPlans(r.plans);
      say("Valor da Speed atualizado");
    } catch (e) {
      say(errMsg(e, "Falha ao salvar."), "bad");
    }
  }
  return (
    <div className="card">
      <div className="ch"><h3>Valor por porta ativada</h3><small>o que a Speed cobra, por plano</small></div>
      <table className="hist">
        <tbody>
          {plans.map((p) => {
            const cents = parseBrl(text[p.id] ?? "");
            const changed = Number.isFinite(cents) && cents >= 100 && cents !== p.speedPriceCents;
            return (
              <tr key={p.id}>
                <td style={{ fontFamily: "var(--font)" }}>{p.name}</td>
                <td>
                  <span className="inrow">
                    <input value={text[p.id] ?? ""} onChange={(e) => setText({ ...text, [p.id]: e.target.value })} inputMode="decimal" aria-label={`Valor da Speed no ${p.name}`} style={{ maxWidth: 120 }} />
                    <button className="btn sm" disabled={!changed} onClick={() => void save(p.id, cents)}>Salvar</button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Administrador Speed: parceiros, área liberada (siglas), limites, bloqueio e usuários. */
export function PartnersPage() {
  const say = useToast();
  const [list, setList] = useState<AdminPartner[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { partners } = await api.adminPartners();
      setList(partners);
      setSelectedId((cur) => cur ?? partners[0]?.id ?? null);
    } catch (e) {
      say(errMsg(e, "Falha ao carregar parceiros."), "bad");
      setList((prev) => prev ?? []);
    }
  }, [say]);
  useEffect(() => {
    void load();
  }, [load]);

  const selected = list?.find((p) => p.id === selectedId) ?? null;

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Parceiros</h1>
          <p>Quem vende na rede da Speed, em que área e com quais limites.</p>
        </div>
        {!creating && <button className="btn" onClick={() => setCreating(true)}>Novo parceiro</button>}
      </div>

      <SignalLimitCard />
      <OsPhotosCard />
      <SlaCard />
      <CtoLimitsCard />
      <ApprovalsCard />
      <SpeedPricesCard />

      <div className="g11">
        <div className="card">
          <div className="ch"><h3>{list ? `${list.length} ${list.length === 1 ? "parceiro" : "parceiros"}` : "Carregando…"}</h3><small>clique para editar</small></div>
          {list && list.length === 0 && <p className="empty">Nenhum parceiro ainda.</p>}
          {list && list.length > 0 && (
            <table className="hist plist">
              <thead>
                <tr><th>Parceiro</th><th>Área</th><th>Reservas</th><th>Usuários</th></tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} className={p.id === selectedId && !creating ? "on" : ""}>
                    <td style={{ fontFamily: "var(--font)" }}>
                      <button className="rowbtn" onClick={() => { setCreating(false); setSelectedId(p.id); }}>
                        {p.name}
                        {p.status === "bloqueado" && <span className="badge b-bad" style={{ marginLeft: 8 }}>Bloqueado</span>}
                      </button>
                      <div className="muted mono" style={{ fontSize: 12 }}>{p.code ? `${p.code} · ` : ""}{fmtCnpj(p.cnpj)}</div>
                    </td>
                    <td>{p.allowedRegions.length ? p.allowedRegions.join(" · ") : <span className="muted">nenhuma</span>}</td>
                    <td className="tab">{p.activeReservations} / {p.maxActiveReservations}</td>
                    <td className="tab">{p.activeUsers} / {p.maxUsers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {creating ? (
          <NewPartnerForm
            onCancel={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              setSelectedId(id);
              void load();
            }}
          />
        ) : selected ? (
          // key: ao trocar de parceiro, o formulário recomeça com os dados dele.
          <PartnerEditor key={`${selected.id}-${selected.code}-${selected.status}-${selected.allowedRegions.join()}-${selected.maxActiveReservations}-${selected.maxCtoOccupancyPct}-${selected.maxUsers}`} partner={selected} onChanged={() => void load()} />
        ) : (
          list && <p className="note">Selecione um parceiro ou cadastre o primeiro.</p>
        )}
      </div>
    </main>
  );
}
