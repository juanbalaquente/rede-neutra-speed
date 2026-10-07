import { useEffect, useState } from "react";
import { api, type AdminPartner, type AuditEntry } from "../api";

const ACTIONS: { value: string; label: string }[] = [
  { value: "", label: "Todas as ações" },
  { value: "reserva.", label: "Reservas" },
  { value: "viabilidade.", label: "Consultas de viabilidade" },
  { value: "usuario.", label: "Usuários" },
  { value: "parceiro.", label: "Parceiros" },
  { value: "auth.", label: "Entradas no portal" },
];

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Entrou no portal",
  "viabilidade.consultada": "Consultou viabilidade",
  "reserva.criada": "Reservou vaga",
  "reserva.cancelada": "Cancelou reserva",
  "reserva.expirada": "Reserva expirou",
  "usuario.criado": "Cadastrou usuário",
  "usuario.ativado": "Reativou usuário",
  "usuario.desativado": "Desativou usuário",
  "parceiro.criado": "Cadastrou parceiro",
  "parceiro.alterado": "Alterou parceiro",
};

const CHANGE_LABEL: Record<string, string> = {
  status: "situação",
  allowedRegions: "siglas",
  maxActiveReservations: "reservas simultâneas",
  maxCtoOccupancyPct: "ocupação por CTO",
  maxUsers: "usuários",
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Uma linha legível a partir do "data" de cada ação. Valores desconhecidos não aparecem. */
function detail(e: AuditEntry): string {
  const d = e.data ?? {};
  switch (e.action) {
    case "reserva.criada":
      return [d.cto, d.regiao].filter(Boolean).join(" · ");
    case "reserva.cancelada":
      return d.reason ? `${d.byAdmin ? "pela Speed: " : ""}${String(d.reason)}` : "";
    case "viabilidade.consultada":
      return d.viable ? "com viabilidade" : "sem viabilidade";
    case "parceiro.alterado": {
      const changes = (d.changes ?? {}) as Record<string, unknown>;
      const parts = Object.entries(changes).map(([k, v]) => `${CHANGE_LABEL[k] ?? k}: ${Array.isArray(v) ? v.join(", ") || "nenhuma" : String(v)}`);
      if (d.reason) parts.push(`motivo: ${String(d.reason)}`);
      return parts.join(" · ");
    }
    default:
      return "";
  }
}

/** Administrador Speed: quem fez o quê, quando, em nome de qual parceiro. */
export function AuditPage() {
  const [partners, setPartners] = useState<AdminPartner[]>([]);
  const [filters, setFilters] = useState({ partnerId: "", action: "", days: 7 });
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminPartners().then((r) => setPartners(r.partners)).catch(() => setPartners([]));
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .audit(filters)
      .then((r) => alive && setEntries(r.entries))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Falha ao carregar."));
    return () => {
      alive = false;
    };
  }, [filters]);

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Auditoria</h1>
          <p>Tudo que mexe na rede ou no cadastro, com quem fez e quando.</p>
        </div>
      </div>

      <div className="filters">
        <label className="fld">
          <span>Parceiro</span>
          <select value={filters.partnerId} onChange={(e) => setFilters({ ...filters, partnerId: e.target.value })}>
            <option value="">Todos</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Ação</span>
          <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Período</span>
          <select value={filters.days} onChange={(e) => setFilters({ ...filters, days: Number(e.target.value) })}>
            <option value={1}>Últimas 24 horas</option>
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {/* Mantém a lista anterior, esmaecida, enquanto o filtro novo carrega. */}
      {entries && (
        <div className="card">
          <div className="ch"><h3>{entries.length === 300 ? "Últimos 300 registros" : `${entries.length} registros`}</h3><small>mais recentes primeiro</small></div>
          {entries.length === 0 ? (
            <p className="empty">Nada registrado com esses filtros.</p>
          ) : (
            <table className="hist">
              <thead>
                <tr><th>Quando</th><th>Quem</th><th>Parceiro</th><th>Ação</th><th>Detalhe</th><th>IP</th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="tab" style={{ whiteSpace: "nowrap" }}>{fmtWhen(e.createdAt)}</td>
                    <td style={{ fontFamily: "var(--font)" }}>
                      {e.userName ?? <span className="muted">sistema</span>}
                      {e.userEmail && <div className="muted" style={{ fontSize: 12 }}>{e.userEmail}</div>}
                    </td>
                    <td style={{ fontFamily: "var(--font)" }}>{e.partnerName ?? <span className="muted">Speed</span>}</td>
                    <td style={{ fontFamily: "var(--font)" }}>{ACTION_LABEL[e.action] ?? e.action}</td>
                    <td style={{ fontFamily: "var(--font)" }}>{detail(e)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{e.ip ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}
