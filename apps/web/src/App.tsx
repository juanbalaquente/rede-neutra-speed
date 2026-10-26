import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clientStatusApi, type Fleet } from "./clientStatusApi";
import { loadOverview, type Overview } from "./ui/SpeedOverview";
import { api, type AdminPartner, type Dashboard, type Installation, type MfaState, type Partner, type Reservation, type User } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { MfaSetupPage } from "./pages/MfaSetupPage";
import { ConferirPage } from "./pages/ConferirPage";
import { CapacityRequestsPage } from "./pages/CapacityRequestsPage";
import { AuditPage } from "./pages/AuditPage";
import { PanelPage } from "./pages/PanelPage";
import { PartnersPage } from "./pages/PartnersPage";
import { TeamPage } from "./pages/TeamPage";
import { AgendaPage } from "./pages/AgendaPage";
import { FinancePage } from "./pages/FinancePage";
import { PartnerDashboardPage } from "./pages/PartnerDashboardPage";
import { InstallationsPage } from "./pages/InstallationsPage";
import { OnusPage } from "./pages/OnusPage";
import { ReservationsPage } from "./pages/ReservationsPage";
import { TicketsPage } from "./pages/TicketsPage";
import { ViabilityPage } from "./pages/ViabilityPage";
import { CommandPalette, type Command } from "./ui/CommandPalette";
import { CalendarIcon, CameraIcon, ChartIcon, ChatIcon, ClockIcon, InboxIcon, ListIcon, OnuIcon, OutIcon, PeopleIcon, PinIcon, SearchIcon, ShieldIcon } from "./ui/Icons";
import { Bell, type Notice } from "./ui/Bell";
import { ToastProvider, useToast } from "./ui/Toast";
import { THEMES, useTheme } from "./ui/theme";
import { THEME_ICON, ThemeMenu } from "./ui/ThemeMenu";

type Tab = "inicio" | "onus" | "financeiro" | "viabilidade" | "reservas" | "instalacoes" | "agenda" | "chamados" | "conferir" | "pedidos" | "parceiros" | "painel" | "auditoria" | "equipe";

const ROLE_LABEL: Record<User["role"], string> = {
  atendente: "Atendente",
  supervisor: "Supervisor",
  admin_speed: "Administrador Speed",
};

/** A partir de quanto tempo antes do vencimento o portal avisa o parceiro. */
const EXPIRY_WARN_MS = 3 * 3600_000;

const PARTNER_TABS: Tab[] = ["inicio", "viabilidade", "reservas", "instalacoes", "agenda", "onus", "chamados"];
const TABS_BY_ROLE: Record<User["role"], Tab[]> = {
  atendente: PARTNER_TABS,
  supervisor: [...PARTNER_TABS, "financeiro", "equipe"],
  admin_speed: ["viabilidade", "reservas", "instalacoes", "agenda", "chamados", "painel", "parceiros", "pedidos", "auditoria", "conferir"],
};

/** Tela escolhida na barra de endereço (#/reservas); vale só se o perfil pode ver. */
function tabFromHash(role: User["role"]): Tab | null {
  const name = window.location.hash.replace(/^#\/?/, "").split("/")[0] as Tab;
  return TABS_BY_ROLE[role].includes(name) ? name : null;
}

const TAB_LABEL: Record<Tab, string> = { inicio: "Painel", financeiro: "Financeiro", viabilidade: "Nova venda", reservas: "Reservas", instalacoes: "Instalações", agenda: "Agenda", onus: "ONUs", chamados: "Chamados", conferir: "CTOs para conferir", pedidos: "Pedidos de vaga", parceiros: "Parceiros", painel: "Painel da rede", auditoria: "Auditoria", equipe: "Equipe" };

export function App() {
  return (
    <ToastProvider>
      <Portal />
    </ToastProvider>
  );
}

function Portal() {
  const [user, setUser] = useState<User | null>(null);
  const [mfa, setMfa] = useState<MfaState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .session()
      .then((r) => {
        setUser(r.user);
        setMfa(r.mfa);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center muted">Carregando…</div>;
  if (!user) {
    return (
      <LoginPage
        onLogin={(u, m) => {
          setUser(u);
          setMfa(m);
        }}
      />
    );
  }
  // Supervisor e administrador só passam daqui com o segundo fator configurado.
  if (mfa?.setupRequired) {
    return (
      <MfaSetupPage
        user={user}
        onDone={() => setMfa({ ...mfa, enabled: true, setupRequired: false })}
        onLogout={() => {
          void api.logout().catch(() => {});
          setUser(null);
        }}
      />
    );
  }
  return <Shell user={user} onLogout={() => setUser(null)} />;
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { theme, choose } = useTheme();
  // O administrador Speed começa pela gestão; o parceiro, pela venda.
  const home: Tab = user.role === "admin_speed" ? "painel" : "inicio";
  const [tab, setTabState] = useState<Tab>(() => tabFromHash(user.role) ?? home);
  // Cada tela tem endereço próprio: F5 fica na tela, o botão voltar do navegador volta de tela e dá para guardar o link.
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    if (window.location.hash !== `#/${next}`) window.location.hash = `/${next}`;
  }, []);
  useEffect(() => {
    if (window.location.hash !== `#/${tab}`) window.history.replaceState(null, "", `#/${tab}`);
    const onHash = () => setTabState(tabFromHash(user.role) ?? home);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.role]);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [seed, setSeed] = useState<{ address: string; nonce: number } | null>(null);
  /** Reserva recém-criada: a tela de Reservas abre o formulário de dados do cliente nela. */
  const [clienteFor, setClienteFor] = useState<string | null>(null);
  /** Instalação aberta a partir da agenda. */
  const [instId, setInstId] = useState<string | null>(null);
  const [ticketFor, setTicketFor] = useState<string | null>(null);
  /** ONU aberta a partir de um alarme do sino. */
  const [onuId, setOnuId] = useState<string | null>(null);

  /** Criação de contrato pelo portal ligada (CONTRACT_MODE): o contrato sai no agendamento, antes da visita. */
  const [contractsEnabled, setContractsEnabled] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.reservations();
      setReservations(r.reservations);
      setContractsEnabled(!!r.contractsEnabled);
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

  // Avisos do sino: o parceiro vê visitas atrasadas e O.S. pendentes; a Speed vê a rede fora do ar.
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rede, setRede] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pedidos, setPedidos] = useState(0);
  const loadPedidos = useCallback(() => {
    if (user.role !== "admin_speed") return;
    api.capacityRequests("pendente").then((r) => setPedidos(r.requests.length)).catch(() => {});
  }, [user.role]);
  useEffect(() => {
    const isAdmin = user.role === "admin_speed";
    const poll = () => {
      if (isAdmin) {
        loadPedidos();
        api.integrationsHealth().then((h) => setRede({ ok: h.ok, detail: h.detail })).catch(() => {});
        loadOverview().then(setOverview).catch(() => {});
      }
      else {
        api.dashboard().then(setDash).catch(() => {});
        // Desligado (503) ou fora do ar: sem alarme, sem barulho.
        clientStatusApi.fleet().then(setFleet).catch(() => setFleet(null));
      }
    };
    poll();
    const t = setInterval(poll, isAdmin ? 60_000 : 120_000);
    return () => clearInterval(t);
  }, [user.role, loadPedidos]);

  // A instalação escolhida na agenda só vale para a abertura da tela.
  useEffect(() => {
    if (tab !== "instalacoes") setInstId(null);
    if (tab !== "chamados") setTicketFor(null);
    if (tab !== "onus") setOnuId(null);
  }, [tab]);

  // O formulário de dados do cliente só abre logo depois de reservar.
  useEffect(() => {
    if (tab !== "reservas") setClienteFor(null);
  }, [tab]);

  // Dados da busca (Ctrl K): contratos e clientes de quem pode ver; parceiros só para a Speed. Carrega ao abrir a busca.
  const [searchData, setSearchData] = useState<{ inst: Installation[]; partners: AdminPartner[] }>({ inst: [], partners: [] });
  const searchLoaded = useRef(false);
  useEffect(() => {
    // Carrega uma vez ao abrir o portal (a busca já nasce pronta) e atualiza cada vez que a busca abre.
    if (!paletteOpen && searchLoaded.current) return;
    searchLoaded.current = true;
    api.installations().then((r) => setSearchData((d) => ({ ...d, inst: r.installations }))).catch(() => {});
    if (user.role === "admin_speed") api.adminPartners().then((r) => setSearchData((d) => ({ ...d, partners: r.partners }))).catch(() => {});
  }, [paletteOpen, user.role]);
  const searchData2 = useCallback(
    (q: string): Command[] => {
      const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(q);
      const clients = searchData.inst
        .filter((i) => has(i.contract) || has(i.nickname) || has(i.address) || has(i.ctoName) || has(i.onuSerial) || has(i.partnerName))
        .slice(0, 8)
        .map<Command>((i) => ({
          id: `inst-${i.id}`,
          group: "Contratos e clientes",
          title: `${i.contract ?? "sem contrato"} · ${i.nickname ?? i.address}`,
          hint: i.partnerName ?? i.ctoName,
          icon: <ListIcon />,
          run: () => { setInstId(i.id); setTab("instalacoes"); },
        }));
      const parceiros = searchData.partners
        .filter((x) => has(x.name) || has(x.code) || has(x.cnpj))
        .slice(0, 5)
        .map<Command>((x) => ({ id: `par-${x.id}`, group: "Parceiros", title: x.name, hint: x.code ?? undefined, icon: <PeopleIcon />, run: () => setTab("parceiros") }));
      return [...clients, ...parceiros];
    },
    [searchData, setTab],
  );

  const activeCount = reservations?.filter((r) => r.status === "ativa").length ?? 0;

  // Reservas que vencem em menos de 3 h: aviso no menu e, uma vez por reserva, no toast.
  const say = useToast();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const soon = useMemo(
    () => (user.role === "admin_speed" ? [] : (reservations ?? []).filter((r) => r.status === "ativa" && r.expiresAt && new Date(r.expiresAt).getTime() - clock < EXPIRY_WARN_MS && new Date(r.expiresAt).getTime() > clock)),
    [reservations, clock, user.role],
  );
  // Visita de hoje ou amanhã sem contrato concluído: o técnico chegaria e teria de esperar o contrato e o sistema de rede.
  const semContrato = useMemo(() => {
    if (user.role === "admin_speed" || !contractsEnabled) return 0;
    return (reservations ?? []).filter((r) => {
      if (r.status !== "ativa" || !r.visitAt) return false;
      const until = new Date(r.visitAt).getTime() - clock;
      return until > -12 * 3600_000 && until < 36 * 3600_000 && r.contractRequest?.state !== "concluida";
    }).length;
  }, [reservations, clock, user.role, contractsEnabled]);
  const warned = useRef(new Set<string>());
  useEffect(() => {
    const fresh = soon.filter((r) => !warned.current.has(r.id));
    if (fresh.length === 0) return;
    fresh.forEach((r) => warned.current.add(r.id));
    const first = fresh[0]!;
    const mins = Math.max(1, Math.round((new Date(first.expiresAt!).getTime() - Date.now()) / 60_000));
    const when = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}` : `${mins} min`;
    say(fresh.length === 1 ? `A reserva da ${first.ctoName} vence em ${when}.` : `${fresh.length} reservas vencem em menos de 3 horas.`, "bad");
  }, [soon, say]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    onLogout();
  }, [onLogout]);

  const commands = useMemo<Command[]>(
    () => [
      ...(user.role !== "admin_speed" ? [{ id: "go-inicio", group: "Ir para", title: "Painel", icon: <ChartIcon />, run: () => setTab("inicio") }] : []),
      ...(user.role === "supervisor" ? [{ id: "go-fin", group: "Ir para", title: "Financeiro", icon: <ChartIcon />, run: () => setTab("financeiro") }] : []),
      { id: "go-viab", group: "Ir para", title: "Nova venda", icon: <PinIcon />, run: () => setTab("viabilidade") },
      ...(user.role === "admin_speed"
        ? [
            { id: "go-painel", group: "Ir para", title: "Painel da rede", icon: <ChartIcon />, run: () => setTab("painel") },
            { id: "go-auditoria", group: "Ir para", title: "Auditoria", icon: <ShieldIcon />, run: () => setTab("auditoria") },
          ]
        : []),
      ...(user.role === "supervisor" ? [{ id: "go-equipe", group: "Ir para", title: "Equipe", icon: <PeopleIcon />, run: () => setTab("equipe") }] : []),
      ...(user.role === "admin_speed" ? [{ id: "go-parceiros", group: "Ir para", title: "Parceiros", icon: <PeopleIcon />, run: () => setTab("parceiros") }] : []),
      ...(user.role === "admin_speed" ? [{ id: "go-pedidos", group: "Ir para", title: "Pedidos de vaga", hint: `${pedidos} esperando`, icon: <InboxIcon />, run: () => setTab("pedidos") }] : []),
      ...(user.role === "admin_speed" ? [{ id: "go-conferir", group: "Ir para", title: "CTOs para conferir", icon: <PinIcon />, run: () => setTab("conferir") }] : []),
      { id: "go-inst", group: "Ir para", title: "Instalações", icon: <CameraIcon />, run: () => setTab("instalacoes") },
      { id: "go-agenda", group: "Ir para", title: "Agenda", icon: <CalendarIcon />, run: () => setTab("agenda") },
      ...(user.role !== "admin_speed" ? [{ id: "go-onus", group: "Ir para", title: "ONUs", hint: fleet?.alarmes.length ? `${fleet.alarmes.length} com problema` : undefined, icon: <OnuIcon />, run: () => setTab("onus") }] : []),
      { id: "go-chamados", group: "Ir para", title: "Chamados", icon: <ChatIcon />, run: () => setTab("chamados") },
      { id: "go-resv", group: "Ir para", title: "Reservas", hint: `${activeCount} abertas`, icon: <ClockIcon />, run: () => setTab("reservas") },
      ...THEMES.filter((t) => t.id !== theme).map((t) => {
        const Ico = THEME_ICON[t.id];
        return { id: `theme-${t.id}`, group: "Preferências", title: `Usar tema ${t.label.toLowerCase()}`, icon: <Ico />, run: () => choose(t.id) };
      }),
      { id: "out", group: "Preferências", title: "Sair", icon: <OutIcon />, run: () => void logout() },
    ],
    [activeCount, pedidos, theme, choose, logout, user.role, fleet],
  );

  const notices = useMemo<Notice[]>(() => {
    const list: Notice[] = [];
    if (soon.length) list.push({ id: "expira", tone: "warn", text: soon.length === 1 ? "Uma reserva vence em menos de 3 horas" : `${soon.length} reservas vencem em menos de 3 horas`, onOpen: () => setTab("reservas") });
    if (dash?.visitasAtrasadas) list.push({ id: "atrasadas", tone: "bad", text: dash.visitasAtrasadas === 1 ? "Uma visita passou do dia sem ser concluída" : `${dash.visitasAtrasadas} visitas passaram do dia sem ser concluídas`, onOpen: () => setTab("agenda") });
    if (dash?.osPendentes) list.push({ id: "os", tone: "warn", text: dash.osPendentes === 1 ? "Uma O.S. pendente: ONU liberada, falta fechar" : `${dash.osPendentes} O.S. pendentes: ONU liberada, falta fechar`, onOpen: () => setTab("instalacoes") });
    if (dash?.chamadosAtrasados) list.push({ id: "chamados", tone: "bad", text: dash.chamadosAtrasados === 1 ? "Um chamado passou do prazo da Infra" : `${dash.chamadosAtrasados} chamados passaram do prazo da Infra`, onOpen: () => setTab("chamados") });
    if (fleet?.alarmes.length) list.push({ id: "fibra", tone: "bad", text: fleet.alarmes.length === 1 ? "Um cliente está sem fibra ou sem PPPoE" : `${fleet.alarmes.length} clientes estão sem fibra ou sem PPPoE`, onOpen: () => { if (fleet.alarmes.length === 1) setOnuId(fleet.alarmes[0]!.reservationId); setTab("onus"); } });
    if (overview?.hotspots.length) list.push({ id: "hotspots", tone: "warn", text: overview.hotspots.length === 1 ? "Uma CTO com muitos chamados do mesmo parceiro" : `${overview.hotspots.length} CTOs com muitos chamados do mesmo parceiro`, onOpen: () => setTab("painel") });
    if (overview?.totais.chamadosAtrasados) list.push({ id: "chamados-atrasados", tone: "bad", text: `${overview.totais.chamadosAtrasados} chamado(s) de parceiros fora do prazo`, onOpen: () => setTab("chamados") });
    if (overview?.totais.contratosComProblema) list.push({ id: "contratos", tone: "bad", text: `${overview.totais.contratosComProblema} contrato(s) com problema na criação`, onOpen: () => setTab("painel") });
    if (overview?.totais.aprovacoesPendentes) list.push({ id: "aprovacoes", tone: "warn", text: `${overview.totais.aprovacoesPendentes} operação(ões) esperando a aprovação da Speed`, onOpen: () => setTab("parceiros") });
    if (pedidos > 0) list.push({ id: "pedidos", tone: "warn", text: pedidos === 1 ? "Um pedido de vaga esperando a Speed" : `${pedidos} pedidos de vaga esperando a Speed`, onOpen: () => setTab("pedidos") });
    if (rede && !rede.ok) list.push({ id: "rede", tone: "bad", text: "A integração com a rede está com problema", onOpen: () => setTab("painel") });
    if (semContrato > 0) list.push({ id: "sem-contrato", tone: "bad", text: semContrato === 1 ? "Uma visita de hoje ou amanhã ainda sem contrato pronto" : `${semContrato} visitas de hoje ou amanhã ainda sem contrato pronto`, onOpen: () => setTab("reservas") });
    return list;
  }, [soon, dash, fleet, overview, rede, pedidos, semContrato]);

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
          {user.role !== "admin_speed" && (
            <button className={`nv ${tab === "inicio" ? "on" : ""}`} onClick={() => setTab("inicio")}>
              <ChartIcon />Painel
            </button>
          )}
          <div className="grp">Vendas</div>
          <button className={`nv ${tab === "viabilidade" ? "on" : ""}`} onClick={() => setTab("viabilidade")}>
            <PinIcon />Nova venda
          </button>
          <button className={`nv ${tab === "reservas" ? "on" : ""}`} onClick={() => setTab("reservas")}>
            <ClockIcon />Reservas {reservations && <em className={soon.length ? "warn" : ""} title={soon.length ? `${soon.length} vence(m) em menos de 3 horas` : undefined}>{activeCount}</em>}
          </button>
          <button className={`nv ${tab === "instalacoes" ? "on" : ""}`} onClick={() => setTab("instalacoes")}>
            <CameraIcon />Instalações
          </button>
          <button className={`nv ${tab === "agenda" ? "on" : ""}`} onClick={() => setTab("agenda")}>
            <CalendarIcon />Agenda
          </button>
          {user.role !== "admin_speed" && (
            <>
              <div className="grp">Suporte</div>
              <button className={`nv ${tab === "onus" ? "on" : ""}`} onClick={() => setTab("onus")}>
                <OnuIcon />ONUs {!!fleet?.alarmes.length && <em className="warn" title={`${fleet.alarmes.length} sem fibra ou sem PPPoE`}>{fleet.alarmes.length}</em>}
              </button>
              <button className={`nv ${tab === "chamados" ? "on" : ""}`} onClick={() => setTab("chamados")}>
                <ChatIcon />Chamados {!!dash?.chamadosAbertos && <em className={dash.chamadosAtrasados ? "warn" : ""}>{dash.chamadosAbertos}</em>}
              </button>
            </>
          )}
          {user.role === "supervisor" && (
            <>
              <div className="grp">Gestão</div>
              <button className={`nv ${tab === "financeiro" ? "on" : ""}`} onClick={() => setTab("financeiro")}>
                <ChartIcon />Financeiro
              </button>
              <button className={`nv ${tab === "equipe" ? "on" : ""}`} onClick={() => setTab("equipe")}>
                <PeopleIcon />Equipe
              </button>
            </>
          )}
          {user.role === "admin_speed" && (
            <>
              <div className="grp">Gestão</div>
              <button className={`nv ${tab === "painel" ? "on" : ""}`} onClick={() => setTab("painel")}>
                <ChartIcon />Painel da rede
              </button>
              <button className={`nv ${tab === "parceiros" ? "on" : ""}`} onClick={() => setTab("parceiros")}>
                <PeopleIcon />Parceiros
              </button>
              <button className={`nv ${tab === "chamados" ? "on" : ""}`} onClick={() => setTab("chamados")}>
                <ChatIcon />Chamados
              </button>
              <button className={`nv ${tab === "pedidos" ? "on" : ""}`} onClick={() => setTab("pedidos")}>
                <InboxIcon />Pedidos de vaga {pedidos > 0 && <em className="warn">{pedidos}</em>}
              </button>
              <button className={`nv ${tab === "auditoria" ? "on" : ""}`} onClick={() => setTab("auditoria")}>
                <ShieldIcon />Auditoria
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
            <span>Buscar endereço, contrato ou ir para…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <Bell notices={notices} />
          <ThemeMenu theme={theme} onChoose={choose} />
          <button className="ibtn mobile-out" onClick={() => void logout()} aria-label="Sair">
            <OutIcon />
          </button>
        </header>
        {user.role === "admin_speed" && rede && !rede.ok && (
          <div className="banner bad" role="alert">
            <b>Integração com a rede fora do ar.</b> {rede.detail} Viabilidade e reserva podem falhar ou vir como "conferir".
          </div>
        )}

        {tab === "painel" && user.role === "admin_speed" ? (
          <PanelPage onGo={setTab} pedidos={pedidos} />
        ) : tab === "auditoria" && user.role === "admin_speed" ? (
          <AuditPage />
        ) : tab === "equipe" && user.role === "supervisor" ? (
          <TeamPage user={user} partner={partner} />
        ) : tab === "parceiros" && user.role === "admin_speed" ? (
          <PartnersPage />
        ) : tab === "conferir" && user.role === "admin_speed" ? (
          <ConferirPage />
        ) : tab === "pedidos" && user.role === "admin_speed" ? (
          <CapacityRequestsPage onChanged={loadPedidos} />
        ) : tab === "inicio" && user.role !== "admin_speed" ? (
          <PartnerDashboardPage user={user} onGo={(t, id) => { if (id) setInstId(id); setTab(t); }} />
        ) : tab === "financeiro" && user.role === "supervisor" ? (
          <FinancePage />
        ) : tab === "onus" && user.role !== "admin_speed" ? (
          <OnusPage
            user={user}
            initialId={onuId}
            onOpenTicket={(id) => { setTicketFor(id); setTab("chamados"); }}
            onOpenInstallation={(id) => { setInstId(id); setTab("instalacoes"); }}
          />
        ) : tab === "chamados" ? (
          <TicketsPage key={ticketFor ?? "lista"} user={user} startFor={ticketFor} />
        ) : tab === "agenda" ? (
          <AgendaPage user={user} onOpenInstallation={(id) => { setInstId(id); setTab("instalacoes"); }} />
        ) : tab === "instalacoes" ? (
          <InstallationsPage user={user} initialId={instId} onOpenTicket={(id) => { setTicketFor(id); setTab("chamados"); }} />
        ) : tab === "viabilidade" ? (
          <ViabilityPage
            user={user}
            partner={partner}
            seed={seed}
            onReserved={(id) => {
              void reload();
              setClienteFor(id);
              setTab("reservas");
            }}
          />
        ) : (
          <ReservationsPage user={user} partner={partner} items={reservations} reload={reload} openClienteFor={clienteFor} contractsEnabled={contractsEnabled} />
        )}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} onAddress={user.role === "admin_speed" ? null : consult} search={searchData2} />
    </div>
  );
}
