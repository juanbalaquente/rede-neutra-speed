import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, type AdminPartner, type PartnerLimits, type PartnerUser } from "../api";
import { useToast } from "../ui/Toast";

/** Siglas do piloto (OLTs Backbone Central, Itacolomi e Fátima). */
const PILOT_REGIONS = ["R1", "ITA", "FAT"];
const REGION_RE = /^[A-Z0-9]{1,8}$/;
const DEFAULT_LIMITS: PartnerLimits = { maxActiveReservations: 10, maxCtoOccupancyPct: 50, maxUsers: 10 };

const fmtCnpj = (d: string) => (d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d);
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Senha forte para o primeiro acesso: 14 caracteres, com letra e número garantidos. */
function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${Array.from(bytes, (b) => chars[b % chars.length]).join("")}a7`;
}

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

function UsersSection({ partner }: { partner: AdminPartner }) {
  const say = useToast();
  const [users, setUsers] = useState<PartnerUser[] | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "supervisor" as "atendente" | "supervisor" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.users(partner.id).then((r) => setUsers(r.users)).catch((e) => say(errMsg(e, "Falha ao carregar usuários."), "bad"));
  }, [partner.id, say]);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createUser({ partnerId: partner.id, ...form });
      say(`${form.name} cadastrado. Envie a senha por um canal seguro.`);
      setForm({ name: "", email: "", password: "", role: "atendente" });
      load();
    } catch (err) {
      say(errMsg(err, "Falha ao cadastrar."), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(u: PartnerUser) {
    try {
      await api.setUserActive(u.id, !u.active);
      say(u.active ? `${u.name} desativado` : `${u.name} reativado`);
      load();
    } catch (err) {
      say(errMsg(err, "Falha ao alterar."), "bad");
    }
  }

  const active = users?.filter((u) => u.active).length ?? 0;
  return (
    <div className="card">
      <div className="ch"><h3>Usuários</h3><small>{users ? `${active} de ${partner.maxUsers} ativos` : "carregando…"}</small></div>
      {users && users.length === 0 && <p className="empty">Nenhum usuário ainda. Cadastre o supervisor do parceiro para ele entrar no portal.</p>}
      {users && users.length > 0 && (
        <table className="hist">
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={{ fontFamily: "var(--font)" }}>
                  {u.name}
                  <div className="muted" style={{ fontSize: 12 }}>{u.email}</div>
                </td>
                <td>{u.role === "supervisor" ? "Supervisor" : "Atendente"}</td>
                <td>
                  <span className={`badge ${u.active ? "b-ok" : "b-mute"}`}>{u.active ? "Ativo" : "Inativo"}</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn sec sm" onClick={() => toggle(u)}>{u.active ? "Desativar" : "Reativar"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="summary" onSubmit={create} style={{ borderTop: "1px solid var(--line)" }}>
        <b style={{ fontWeight: 500 }}>Novo usuário</b>
        <div className="g2">
          <label className="fld"><span>Nome</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={2} required /></label>
          <label className="fld"><span>E-mail</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label className="fld">
            <span>Senha inicial</span>
            <span className="inrow">
              <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={10} required autoComplete="new-password" />
              <button type="button" className="btn sec sm" onClick={() => setForm({ ...form, password: generatePassword() })}>Gerar</button>
            </span>
            <small>10+ caracteres, com letra e número.</small>
          </label>
          <label className="fld">
            <span>Perfil</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "atendente" | "supervisor" })}>
              <option value="supervisor">Supervisor</option>
              <option value="atendente">Atendente</option>
            </select>
          </label>
        </div>
        <div><button className="btn sm" disabled={busy || active >= partner.maxUsers}>{busy ? "Cadastrando…" : "Cadastrar usuário"}</button></div>
        {active >= partner.maxUsers && <small className="muted">Limite de usuários atingido. Aumente o limite ou desative alguém.</small>}
      </form>
    </div>
  );
}

function PartnerEditor({ partner, onChanged }: { partner: AdminPartner; onChanged: () => void }) {
  const say = useToast();
  const [regions, setRegions] = useState(partner.allowedRegions);
  const [limits, setLimits] = useState<PartnerLimits>({
    maxActiveReservations: partner.maxActiveReservations,
    maxCtoOccupancyPct: partner.maxCtoOccupancyPct,
    maxUsers: partner.maxUsers,
  });
  const [busy, setBusy] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");

  const regionsChanged = regions.join(",") !== partner.allowedRegions.join(",");
  const changedLimits = (Object.keys(limits) as (keyof PartnerLimits)[]).filter((k) => limits[k] !== partner[k]);
  const dirty = regionsChanged || changedLimits.length > 0;

  async function save() {
    setBusy(true);
    try {
      const changes: Parameters<typeof api.updatePartner>[1] = {};
      if (regionsChanged) changes.allowedRegions = regions;
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
          <RegionsInput value={regions} onChange={setRegions} />
          <LimitsFields value={limits} onChange={setLimits} />
          <div className="acts2" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm" disabled={!dirty || busy} onClick={save}>{busy ? "Salvando…" : "Salvar alterações"}</button>
            {dirty && (
              <button
                className="btn sec sm"
                onClick={() => {
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
            </div>
          )}
        </div>
      </div>
      <UsersSection partner={partner} />
    </div>
  );
}

function NewPartnerForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const say = useToast();
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [busy, setBusy] = useState(false);
  const digits = cnpj.replace(/\D/g, "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { partner } = await api.createPartner({ name: name.trim(), cnpj: digits, allowedRegions: regions, ...limits });
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
            <input value={cnpj} onChange={(e) => setCnpj(e.target.value)} inputMode="numeric" placeholder="00.000.000/0000-00" required />
            {cnpj && digits.length !== 14 && <small className="error">O CNPJ tem 14 dígitos ({digits.length} agora).</small>}
          </label>
        </div>
        <RegionsInput value={regions} onChange={setRegions} />
        <LimitsFields value={limits} onChange={setLimits} />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn sm" disabled={busy || digits.length !== 14 || name.trim().length < 2}>{busy ? "Cadastrando…" : "Cadastrar parceiro"}</button>
          <button type="button" className="btn sec sm" onClick={onCancel}>Cancelar</button>
        </div>
      </div>
    </form>
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

      <div className="g11">
        <div className="card">
          <div className="ch"><h3>{list ? `${list.length} parceiros` : "Carregando…"}</h3><small>clique para editar</small></div>
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
                      <div className="muted mono" style={{ fontSize: 12 }}>{fmtCnpj(p.cnpj)}</div>
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
          <PartnerEditor key={`${selected.id}-${selected.status}-${selected.allowedRegions.join()}-${selected.maxActiveReservations}-${selected.maxCtoOccupancyPct}-${selected.maxUsers}`} partner={selected} onChanged={() => void load()} />
        ) : (
          list && <p className="note">Selecione um parceiro ou cadastre o primeiro.</p>
        )}
      </div>
    </main>
  );
}
