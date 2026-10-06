import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { ReservationsPage } from "./pages/ReservationsPage";
import { ViabilityPage } from "./pages/ViabilityPage";

type Tab = "viabilidade" | "reservas";

const ROLE_LABEL: Record<User["role"], string> = {
  atendente: "Atendente",
  supervisor: "Supervisor",
  admin_speed: "Administrador Speed",
};

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("viabilidade");

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center muted">Carregando…</div>;
  if (!user) return <LoginPage onLogin={setUser} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">speed</span> Rede Neutra
        </div>
        <nav className="tabs">
          <button className={tab === "viabilidade" ? "active" : ""} onClick={() => setTab("viabilidade")}>
            Viabilidade
          </button>
          <button className={tab === "reservas" ? "active" : ""} onClick={() => setTab("reservas")}>
            Reservas
          </button>
        </nav>
        <div className="who">
          <span>{user.name}</span>
          <small>{ROLE_LABEL[user.role]}</small>
          <button
            className="link"
            onClick={async () => {
              await api.logout();
              setUser(null);
            }}
          >
            Sair
          </button>
        </div>
      </header>
      <main className="content">
        {tab === "viabilidade" ? (
          <ViabilityPage user={user} onReserved={() => setTab("reservas")} />
        ) : (
          <ReservationsPage user={user} />
        )}
      </main>
    </div>
  );
}
