import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type PartnerUser } from "../api";
import { useToast } from "./Toast";

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Senha forte para o primeiro acesso: 14 caracteres, com letra e número garantidos. */
function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${Array.from(bytes, (b) => chars[b % chars.length]).join("")}a7`;
}

/**
 * Usuários de um parceiro. O administrador Speed passa o partnerId; o supervisor não passa
 * (o servidor usa o parceiro da sessão e nunca deixa ver outro).
 */
export function UsersPanel({
  partnerId,
  maxUsers,
  meId,
  emptyHint,
}: {
  partnerId?: string;
  maxUsers: number | null;
  /** O próprio usuário não aparece com o botão de desativar. */
  meId: string;
  emptyHint: string;
}) {
  const say = useToast();
  const [users, setUsers] = useState<PartnerUser[] | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: (partnerId ? "supervisor" : "atendente") as "atendente" | "supervisor" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.users(partnerId).then((r) => setUsers(r.users)).catch((e) => say(errMsg(e, "Falha ao carregar usuários."), "bad"));
  }, [partnerId, say]);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createUser({ partnerId, ...form });
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
  const full = maxUsers !== null && active >= maxUsers;
  return (
    <div className="card">
      <div className="ch">
        <h3>Usuários</h3>
        <small>{users ? (maxUsers !== null ? `${active} de ${maxUsers} ativos` : `${active} ativos`) : "carregando…"}</small>
      </div>
      {users && users.length === 0 && <p className="empty">{emptyHint}</p>}
      {users && users.length > 0 && (
        <table className="hist">
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={{ fontFamily: "var(--font)" }}>
                  {u.name}
                  {u.id === meId && <span className="muted"> (você)</span>}
                  <div className="muted" style={{ fontSize: 12 }}>{u.email}</div>
                </td>
                <td>{u.role === "supervisor" ? "Supervisor" : "Atendente"}</td>
                <td>
                  <span className={`badge ${u.active ? "b-ok" : "b-mute"}`}>{u.active ? "Ativo" : "Inativo"}</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  {u.id !== meId && <button className="btn sec sm" onClick={() => toggle(u)}>{u.active ? "Desativar" : "Reativar"}</button>}
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
              <option value="atendente">Atendente</option>
              <option value="supervisor">Supervisor</option>
            </select>
            <small>{form.role === "supervisor" ? "Vê tudo do parceiro e gerencia a equipe." : "Consulta viabilidade e reserva vagas."}</small>
          </label>
        </div>
        <div><button className="btn sm" disabled={busy || full}>{busy ? "Cadastrando…" : "Cadastrar usuário"}</button></div>
        {full && <small className="muted">Limite de usuários atingido. Desative alguém ou peça à Speed para aumentar o limite.</small>}
      </form>
    </div>
  );
}
