import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Partner, type Reservation, type User } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { ConferirPage } from "./pages/ConferirPage";
import { PartnersPage } from "./pages/PartnersPage";
import { ReservationsPage } from "./pages/ReservationsPage";
import { ViabilityPage } from "./pages/ViabilityPage";
import { CommandPalette, type Command } from "./ui/CommandPalette";
import { ClockIcon, MoonIcon, OutIcon, PeopleIcon, PinIcon, SearchIcon, SunIcon } from "./ui/Icons";
import { ToastProvider } from "./ui/Toast";
import { useTheme } from "./ui/theme";

type Tab = "viabilidade" | "reservas" | "conferir" | "parceiros";

const ROLE_LABEL: Record<User["role"], string> = {
  atendente: "Atendente",
  supervisor: "Supervisor",
  admin_speed: "Administrador Speed",
};

const TAB_LABEL: Record<Tab, string> = { viabilidade: "Nova venda", reservas: "Reservas", conferir: "CTOs para conferir", parceiros: "Parceiros" };

export function App() {
  return (
    <ToastProvider>
      <Portal />
    </ToastProvider>
  );
}

function Portal() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center muted">Carregando…</div>;
  if (!user) return <LoginPage onLogin={setUser} />;
  return <Shell user={user} onLogout={() => setUser(null)} />;
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { theme, toggle } = useTheme();
  // O administrador Speed começa pela gestão; o parceiro, pela venda.
  const [tab, setTab] = useState<Tab>(user.role === "admin_speed" ? "parceiros" : "viabilidade");
  const [partner, setPartner] = useState<Partner | null>(null);
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [seed, setSeed] = useState<{ address: string; nonce: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setReservations((await api.reservations()).reservations);
    } catch {
      setReservations((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    api.partner().then((r) => setPartner(r.partner)).catch(() => setPartner(null));
    void reload();
  }, [reload]);

  // Ctrl K (ou ⌘ K) abre a busca de qualquer tela.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeCount = reservations?.filter((r) => r.status === "ativa").length ?? 0;

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    onLogout();
  }, [onLogout]);

  const commands = useMemo<Command[]>(
    () => [
      { id: "go-viab", group: "Ir para", title: "Nova venda", icon: <PinIcon />, run: () => setTab("viabilidade") },
      ...(user.role === "admin_speed" ? [{ id: "go-parceiros", group: "Ir para", title: "Parceiros", icon: <PeopleIcon />, run: () => setTab("parceiros") }] : []),
      ...(user.role === "admin_speed" ? [{ id: "go-conferir", group: "Ir para", title: "CTOs para conferir", icon: <PinIcon />, run: () => setTab("conferir") }] : []),
      { id: "go-resv", group: "Ir para", title: "Reservas", hint: `${activeCount} abertas`, icon: <ClockIcon />, run: () => setTab("reservas") },
      { id: "theme", group: "Preferências", title: theme === "dark" ? "Usar tema claro" : "Usar tema escuro", icon: theme === "dark" ? <SunIcon /> : <MoonIcon />, run: toggle },
      { id: "out", group: "Preferências", title: "Sair", icon: <OutIcon />, run: () => void logout() },
    ],
    [activeCount, theme, toggle, logout, user.role],
  );

  const consult = useCallback((address: string) => {
    setTab("viabilidade");
    setSeed({ address, nonce: Date.now() });
  }, []);

  // O destaque do item ativo desliza entre os itens do menu.
  const navRef = useRef<HTMLDivElement>(null);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(".nv.on");
    setHl(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
  }, [tab]);

  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="app">
      <aside className="side" aria-label="Menu">
        <div className="org">
          <div className="lg"><i /></div>
          <div>
            <b>Rede Neutra</b>
            <small>{partner ? `${partner.name} · parceiro Speed` : "Administração Speed"}</small>
          </div>
        </div>
        <nav className="nav" ref={navRef}>
          {hl && <span className="nav-hl" style={{ transform: `translateY(${hl.top}px)`, height: hl.height }} />}
          <div className="grp">Vendas</div>
          <button className={`nv ${tab === "viabilidade" ? "on" : ""}`} onClick={() => setTab("viabilidade")}>
            <PinIcon />Nova venda
          </button>
          <button className={`nv ${tab === "reservas" ? "on" : ""}`} onClick={() => setTab("reservas")}>
            <ClockIcon />Reservas {reservations && <em>{activeCount}</em>}
          </button>
          {user.role === "admin_speed" && (
            <>
              <div className="grp">Gestão</div>
              <button className={`nv ${tab === "parceiros" ? "on" : ""}`} onClick={() => setTab("parceiros")}>
                <PeopleIcon />Parceiros
              </button>
              <div className="grp">Rede</div>
              <button className={`nv ${tab === "conferir" ? "on" : ""}`} onClick={() => setTab("conferir")}>
                <SearchIcon size={16} />CTOs para conferir
              </button>
            </>
          )}
        </nav>
        <div className="foot">
          <div className="av" aria-hidden="true">{initials}</div>
          <div>
            <b>{user.name}</b>
            <small>{ROLE_LABEL[user.role]}</small>
          </div>
          <button className="linkbtn" onClick={() => void logout()}>Sair</button>
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <div className="crumb">{partner?.name ?? "Speed"} <span>/</span> <b>{TAB_LABEL[tab]}</b></div>
          <button className="sbtn" onClick={() => setPaletteOpen(true)}>
            <SearchIcon />
            <span>Buscar endereço ou ir para…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button className="ibtn" onClick={toggle} aria-label="Trocar tema claro ou escuro">
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="ibtn mobile-out" onClick={() => void logout()} aria-label="Sair">
            <OutIcon />
          </button>
        </header>

        {tab === "parceiros" && user.role === "admin_speed" ? (
          <PartnersPage />
        ) : tab === "conferir" && user.role === "admin_speed" ? (
          <ConferirPage />
        ) : tab === "viabilidade" ? (
          <ViabilityPage
            user={user}
            partner={partner}
            seed={seed}
            onReserved={() => {
              void reload();
              setTab("reservas");
            }}
          />
        ) : (
          <ReservationsPage user={user} partner={partner} items={reservations} reload={reload} />
        )}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} onAddress={user.role === "admin_speed" ? null : consult} />
    </div>
  );
}
