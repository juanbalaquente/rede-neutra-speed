export type Role = "atendente" | "supervisor" | "admin_speed";

export interface User {
  id: string;
  partnerId: string | null;
  role: Role;
  name: string;
}

/** Segundo fator: ligado? obrigatório para este perfil? falta configurar? */
export interface MfaState {
  enabled: boolean;
  required: boolean;
  setupRequired: boolean;
}

/** Senha certa: ou entrou (sessão), ou falta o código do aplicativo (desafio). */
export type LoginResult = { user: User; mfa: MfaState } | { mfa: "required"; challenge: string };

export interface ViabilityCto {
  /** null = a Speed não resolveu a caixa: aparece, mas não vende. */
  ctoId: string | null;
  name: string;
  distanceM: number;
  location: { lat: number; lng: number } | null;
  regiao: string | null;
  /** Total de vagas (saídas de splitter) da CTO. */
  totalVagas: number;
  /** Vagas que o parceiro pode reservar agora. */
  vagas: number;
  blockedReason: "sem_vaga_livre" | "limite_ocupacao" | "conferir" | null;
  proximaAmbigua: boolean;
  /** Só a Speed recebe os motivos; para o parceiro vai vazio. */
  motivos: string[];
}

export interface ConferirRow {
  ctoId: string | null;
  name: string;
  consultas: number;
  enderecos: number;
  parceiros: number;
  ultima: string;
  motivos: string[];
}

export interface Partner {
  id: string;
  name: string;
  /** Código curto do provedor (ex.: JHV); monta o login PPPoE. null = a Speed ainda não cadastrou. */
  code: string | null;
  maxActiveReservations: number;
  maxCtoOccupancyPct: number;
  maxUsers: number;
  /** Siglas de região liberadas pela Speed (R1, ITA, FAT...). */
  allowedRegions: string[];
}

export interface ViabilityResult {
  /** Havia CTOs perto, mas nenhuma na área liberada ao parceiro. */
  foraDaArea: boolean;
  viable: boolean;
  point: { lat: number; lng: number } | null;
  ctos: ViabilityCto[];
  plans: { id: string; name: string; speedMbps: number }[];
}

export type VisitPeriod = "manha" | "tarde";

export interface Reservation {
  /** Dados do cliente (planejamento, etapa 3). Plano, visita e técnico são exigidos para liberar a ONU. */
  planId: string | null;
  nickname: string | null;
  visitAt: string | null;
  /** Nulo em visitas antigas; use `periodOf`. */
  visitPeriod?: VisitPeriod | null;
  technician: string | null;
  visitStatus: "agendada" | "em_execucao" | "concluida" | "reagendada";
  ctoId: string;
  id: string;
  ctoName: string;
  /** Reserva é por vaga; só reservas antigas têm número de porta. */
  port: number | null;
  address: string;
  /** Endereço estruturado da instalação, salvo com os dados do cliente. */
  installAddress?: Address | null;
  lat: number | null;
  lng: number | null;
  ctoLat: number | null;
  ctoLng: number | null;
  status: "ativa" | "convertida" | "cancelada" | "expirada";
  expiresAt: string | null;
  createdAt: string;
  cancelReason: string | null;
}

/** Endereço da instalação, no formato do contrato (CEP só com dígitos). */
export interface Address {
  cep: string;
  rua: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export interface CapacityRequest {
  id: string;
  partnerName: string;
  ctoId: string;
  ctoName: string;
  regiao: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  ctoLat: number | null;
  ctoLng: number | null;
  totalVagas: number | null;
  blockedReason: "sem_vaga_livre" | "limite_ocupacao" | "conferir";
  /** Só a Speed recebe os motivos técnicos. */
  motivos: string[];
  status: "pendente" | "confirmado" | "recusado" | "cancelado";
  decisionNote: string | null;
  decidedAt: string | null;
  reservationId: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Resposta sem JSON vem do nginx: a API não está no ar.
    const fallback = res.status >= 502 ? "Servidor fora do ar. Tente de novo em instantes." : "Erro inesperado.";
    throw new ApiError(res.status, data.error ?? "erro", data.message ?? fallback);
  }
  return data as T;
}

/** Envio de arquivo (multipart): sem Content-Type manual, o navegador monta o boundary. */
async function upload<T>(path: string, input: { kind: string; file: Blob; lat?: number; lng?: number; accuracyM?: number; capturedAt: string }): Promise<T> {
  const form = new FormData();
  form.set("kind", input.kind);
  form.set("capturedAt", input.capturedAt);
  if (input.lat !== undefined && input.lng !== undefined) {
    form.set("lat", String(input.lat));
    form.set("lng", String(input.lng));
  }
  if (input.accuracyM !== undefined) form.set("accuracyM", String(input.accuracyM));
  form.set("file", input.file, "foto.jpg");
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "include", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status === 413 ? "A foto é grande demais." : res.status >= 502 ? "Servidor fora do ar. Tente de novo em instantes." : "Erro inesperado.";
    throw new ApiError(res.status, data.error ?? "erro", data.message ?? fallback);
  }
  return data as T;
}

export const api = {
  login: (email: string, password: string) => request<LoginResult>("POST", "/auth/login", { email, password }),
  login2fa: (challenge: string, input: { code: string } | { recoveryCode: string }) =>
    request<{ user: User; mfa: MfaState }>("POST", "/auth/login/2fa", { challenge, ...input }),
  setup2fa: () => request<{ secret: string; otpauthUrl: string; qr: string }>("POST", "/auth/2fa/setup"),
  enable2fa: (code: string) => request<{ recoveryCodes: string[] }>("POST", "/auth/2fa/enable", { code }),
  reset2fa: (userId: string) => request<{ ok: true }>("POST", `/admin/users/${userId}/2fa/reset`),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  me: () => request<{ user: User; mfa: MfaState }>("GET", "/auth/me"),
  /** Como o `me`, mas sem erro quando ninguém está logado (`user: null`). */
  session: () => request<{ user: User | null; mfa: MfaState | null }>("GET", "/auth/session"),
  conferir: (days: number) => request<{ days: number; rows: ConferirRow[] }>("GET", `/admin/cto-conferir?days=${days}`),
  partner: () => request<{ partner: Partner | null }>("GET", "/partner"),
  viability: (address: string) => request<ViabilityResult>("POST", "/viability", { address }),
  reservations: () => request<{ reservations: Reservation[] }>("GET", "/reservations"),
  reserve: (input: { ctoId: string; address: string; lat?: number | null; lng?: number | null }) =>
    request<{ reservation: Reservation }>("POST", "/reservations", input),
  cancel: (id: string, reason?: string) => request<{ reservation: Reservation }>("POST", `/reservations/${id}/cancel`, { reason }),
  capacityRequests: (status?: CapacityRequest["status"]) =>
    request<{ requests: CapacityRequest[] }>("GET", status ? `/capacity-requests?status=${status}` : "/capacity-requests"),
  requestCapacity: (input: { ctoId: string; address: string; lat?: number | null; lng?: number | null }) =>
    request<{ request: CapacityRequest }>("POST", "/capacity-requests", input),
  cancelCapacityRequest: (id: string) => request<{ request: CapacityRequest }>("POST", `/capacity-requests/${id}/cancel`),
  decideCapacityRequest: (id: string, decision: "confirmar" | "recusar", note?: string) =>
    request<{ request: CapacityRequest }>("POST", `/admin/capacity-requests/${id}/decision`, { decision, note }),

  // ── Administração Speed ──
  adminPartners: () => request<{ partners: AdminPartner[] }>("GET", "/admin/partners"),
  createPartner: (input: PartnerLimits & { name: string; cnpj: string; code?: string; allowedRegions: string[] }) =>
    request<{ partner: AdminPartner }>("POST", "/admin/partners", input),
  updatePartner: (id: string, changes: Partial<PartnerLimits> & { code?: string; allowedRegions?: string[]; status?: AdminPartner["status"]; reason?: string }) =>
    request<{ partner: AdminPartner }>("PATCH", `/admin/partners/${id}`, changes),
  users: (partnerId?: string) => request<{ users: PartnerUser[] }>("GET", partnerId ? `/users?partnerId=${encodeURIComponent(partnerId)}` : "/users"),
  createUser: (input: { partnerId?: string; name: string; email: string; password: string; role: "atendente" | "supervisor" }) =>
    request<{ user: PartnerUser }>("POST", "/users", input),
  setUserActive: (id: string, active: boolean) => request<{ ok: true }>("POST", `/users/${id}/active`, { active }),
  audit: (filters: { partnerId?: string; action?: string; days: number }) =>
    request<{ entries: AuditEntry[] }>("GET", `/admin/audit?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`),
  // ── Fotos de campo ──
  photos: (reservationId: string) => request<{ photos: Photo[] }>("GET", `/reservations/${reservationId}/photos`),
  uploadPhoto: (reservationId: string, input: { kind: PhotoKind; file: Blob; lat?: number; lng?: number; accuracyM?: number; capturedAt: string }) =>
    upload<{ photo: Photo }>(`/reservations/${reservationId}/photos`, input),

  // ── Liberação de ONU (503 ativacao_desligada = recurso desligado) ──
  activations: () => request<{ activations: Activation[] }>("GET", "/activations"),
  pendingOnus: (reservationId: string) => request<{ onus: PendingOnu[] }>("GET", `/reservations/${reservationId}/onus-pendentes`),
  startActivation: (input: { reservationId: string; serial: string; contrato?: string; sinalCtoDbm: number; idempotencyKey: string }) =>
    request<{ activation: Activation }>("POST", "/activations", input),
  activation: (id: string) => request<{ activation: Activation }>("GET", `/activations/${id}`),
  decideActivation: (id: string, decision: { acao: "remedir" | "cancelar" } | { acao: "prosseguir"; justificativa: string }) =>
    request<{ activation: Activation }>("POST", `/activations/${id}/decision`, decision),
  plans: () => request<{ plans: { id: string; name: string; speedMbps: number }[] }>("GET", "/plans"),
  technicians: () => request<{ technicians: string[] }>("GET", "/technicians"),
  cep: (cep: string) => request<{ endereco: { cep: string; rua: string; bairro: string; cidade: string; uf: string } }>("GET", `/cep/${cep}`),
  saveCliente: (id: string, body: { planId: string; nickname: string | null; visitAt: string; visitPeriod: VisitPeriod; technician: string; endereco?: Address }) =>
    request<{ installation: InstallationDetail }>("PATCH", `/reservations/${id}/cliente`, body),

  agenda: (from: string, to: string) => request<{ visits: AgendaVisit[] }>("GET", `/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  reschedule: (id: string, body: { visitAt: string; visitPeriod?: VisitPeriod; technician?: string }) => request<{ installation: InstallationDetail }>("PATCH", `/reservations/${id}/visita`, body),

  // ── Financeiro e painel do parceiro ──
  dashboard: () => request<Dashboard>("GET", "/dashboard"),
  prices: () => request<{ prices: PlanPrice[] }>("GET", "/prices"),
  setPrice: (planId: string, priceCents: number) => request<{ prices: PlanPrice[] }>("PUT", "/prices", { planId, priceCents }),
  finance: (month: string, filters: FinanceFilters = {}) => request<Finance>("GET", `/finance?month=${month}${financeQuery(filters)}`),
  markPayment: (reservationId: string, month: string, paid: boolean) => request<{ ok: true }>("PUT", "/finance/payments", { reservationId, month, paid }),
  adminPlans: () => request<{ plans: { id: string; name: string; speedMbps: number; speedPriceCents: number; active: boolean }[] }>("GET", "/admin/plans"),
  setSpeedPrice: (id: string, speedPriceCents: number) => request<{ plans: { id: string; name: string; speedMbps: number; speedPriceCents: number; active: boolean }[] }>("PATCH", `/admin/plans/${id}`, { speedPriceCents }),

  // ── Automações do cliente (bloquear, desbloquear, reiniciar, cancelar) ──
  operations: (installationId: string) => request<{ operations: CustomerOperation[] }>("GET", `/installations/${installationId}/operations`),
  startOperation: (installationId: string, body: { type: OperationType; reason?: string | null; idempotencyKey?: string }) =>
    request<{ operation: CustomerOperation }>("POST", `/installations/${installationId}/operations`, body),
  operation: (id: string) => request<{ operation: CustomerOperation }>("GET", `/operations/${id}`),
  retryOperation: (id: string) => request<{ operation: CustomerOperation }>("POST", `/operations/${id}/retry`),

  // ── Instalações e O.S. ──
  installations: () => request<{ installations: Installation[] }>("GET", "/installations"),
  installation: (id: string) => request<{ installation: InstallationDetail }>("GET", `/installations/${id}`),
  closeOs: (id: string, body: OsInput) => request<{ installation: InstallationDetail }>("POST", `/reservations/${id}/os/close`, body),
  photoLink: (photoId: string, hours = 48) => request<{ path: string; url: string | null; expiresAt: string }>("POST", `/photos/${photoId}/link`, { hours }),
  osPhotosRequired: () => request<{ obrigatorias: boolean }>("GET", "/admin/settings/fotos-os"),
  setOsPhotosRequired: (obrigatorias: boolean) => request<{ obrigatorias: boolean }>("PUT", "/admin/settings/fotos-os", { obrigatorias }),
  integrationsHealth: () => request<{ mode: string; ok: boolean; detail: string }>("GET", "/admin/integrations/health"),
  signalLimit: () => request<{ limiteDb: number; padraoDb: number }>("GET", "/admin/settings/limite-sinal"),
  setSignalLimit: (limiteDb: number) => request<{ limiteDb: number }>("PUT", "/admin/settings/limite-sinal", { limiteDb }),
  painel: (days: number) => request<NetworkPanel>("GET", `/admin/painel?days=${days}`),
};

export interface AuditEntry {
  id: number;
  createdAt: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  ip: string | null;
  data: Record<string, unknown> | null;
  partnerId: string | null;
  partnerName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
}

export type CtoEstado = "com_vaga" | "sem_vaga" | "conferir";

export interface PanelCto {
  ctoId: string;
  name: string;
  regiao: string | null;
  estado: CtoEstado;
  livres: number | null;
  totalVagas: number | null;
  reservasAbertas: number;
  vistoEm: string;
}

export interface PanelRegion {
  regiao: string | null;
  ctos: PanelCto[];
  comVaga: number;
  semVaga: number;
  conferir: number;
  vagasLivres: number;
  reservasAbertas: number;
}

export interface PanelDay {
  dia: string;
  viavel: number;
  semViabilidade: number;
  foraDaArea: number;
}

export interface NetworkPanel {
  days: number;
  totals: { consultas: number; viaveis: number; foraDaArea: number; reservasAbertas: number; ctosVistas: number; ctosConferir: number };
  porDia: PanelDay[];
  regioes: PanelRegion[];
  foraDaAreaRegioes: { regiao: string; consultas: number }[];
}

export interface PartnerLimits {
  maxActiveReservations: number;
  maxCtoOccupancyPct: number;
  maxUsers: number;
}

export interface AdminPartner extends PartnerLimits {
  id: string;
  name: string;
  code: string | null;
  cnpj: string;
  status: "ativo" | "bloqueado";
  allowedRegions: string[];
  createdAt: string;
  /** Uso atual, calculado na listagem. */
  activeReservations: number;
  activeUsers: number;
}

export type ActivationState =
  | "recebida"
  | "aguardando_cliente"
  | "autorizando"
  | "medindo_sinal"
  | "aguardando_decisao"
  | "provisionando"
  | "online"
  | "falha_provisionamento"
  | "cancelada"
  | "falhou";

export interface PendingOnu {
  serial: string;
  modelo: string;
  vistaEm: string;
}

export interface ActivationSignal {
  ctoDbm: number;
  /** Null até a Wiki ler o sinal da ONU. */
  onuDbm: number | null;
  perdaDb: number | null;
  limiteDb: number;
}

export interface Activation {
  id: string;
  reservationId: string;
  serial: string;
  contract: string;
  pppLogin: string;
  sinalCtoDbm: number;
  limiteDb: number;
  state: ActivationState;
  snapshot: { sinal?: ActivationSignal | null; vlan?: number | null; prazoDecisaoAte?: string | null; motivo?: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  /** Só o administrador Speed enxerga o estado do segundo fator dos outros. */
  totpEnabled?: boolean;
}

export type PhotoKind = "medicao" | "cto_aberta" | "etiqueta_porta" | "medicao_onu" | "sobra_fibra" | "onu_instalada";

export interface Photo {
  id: string;
  reservationId: string;
  contract: string | null;
  kind: PhotoKind;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

/** Endereço do arquivo da foto (exige login: o cookie da sessão vai junto). */
export const photoUrl = (id: string) => `/api/photos/${id}/file`;

export interface Installation {
  id: string;
  partnerId: string;
  /** Só a Speed recebe o nome do parceiro. */
  partnerName: string | null;
  ctoName: string;
  address: string;
  /** Posição do endereço do cliente e da CTO (para os links de rota); null em registros antigos. */
  lat: number | null;
  lng: number | null;
  ctoLat: number | null;
  ctoLng: number | null;
  status: "ativa" | "convertida" | "cancelada";
  contract: string | null;
  nickname: string | null;
  planName: string | null;
  planMbps: number | null;
  visitAt: string | null;
  visitPeriod: VisitPeriod | null;
  technician: string | null;
  visitStatus: "agendada" | "em_execucao" | "concluida" | "reagendada";
  activationState: ActivationState | null;
  onuSerial: string | null;
  photoKinds: PhotoKind[];
  osClosedAt: string | null;
  /** ativo | bloqueado | cancelado. */
  customerStatus: "ativo" | "bloqueado" | "cancelado";
  createdAt: string;
}

export interface OsInput {
  porta?: string | null;
  sinalFinalDbm: number;
  modeloOnu: string;
  serialOnu: string;
  observacao?: string | null;
  /** Obrigatória quando o sinal final fica abaixo do mínimo aceitável. */
  justificativaSinal?: string | null;
}

export interface InstallationDetail extends Installation {
  os: (OsInput & { fechadaPor: string }) | null;
  fotosFaltando: PhotoKind[];
  fotosObrigatorias: boolean;
  /** Menor sinal aceitável na ONU (sinal da CTO menos o limite da ativação); null sem ativação concluída. */
  sinalMinimoDbm: number | null;
  /** Sinal que o sistema leu na ONU durante a ativação (sugestão ao fechar a O.S.). */
  sinalOnuLidoDbm: number | null;
}

export interface AgendaVisit {
  id: string;
  partnerName: string | null;
  contract: string | null;
  nickname: string | null;
  address: string;
  ctoName: string;
  planName: string | null;
  technician: string | null;
  visitAt: string;
  visitPeriod: VisitPeriod;
  visitStatus: "agendada" | "em_execucao" | "concluida" | "reagendada";
  osClosedAt: string | null;
}

export interface PlanPrice {
  planId: string;
  name: string;
  speedMbps: number;
  /** O que a Speed cobra por porta ativada (definido pela Speed). */
  speedPriceCents: number;
  /** Preço de venda do parceiro; null = ainda não cadastrou. */
  salePriceCents: number | null;
}

export interface Dashboard {
  portasAtivas: number;
  reservasAbertas: number;
  osPendentes: number;
  instalacoesNoMes: number;
  visitasHoje: number;
  visitasAtrasadas: number;
  chamadosAbertos: number;
  chamadosAtrasados: number;
  serie: { month: string; instalacoes: number; ativasNoFim: number }[];
  planos: { plano: string; qtd: number }[];
}

export interface FinanceClient {
  id: string;
  contract: string | null;
  nickname: string | null;
  plan: string;
  planId: string;
  priceCents: number | null;
  costCents: number;
  activatedAt: string;
  ctoName: string;
  customerStatus: string;
  paid: boolean | null;
}

export interface FinanceFilters {
  planId?: string;
  cto?: string;
  status?: "ativo" | "bloqueado" | "pago" | "em_aberto";
}

/** "&planId=…&cto=…&status=…" só com o que foi preenchido. */
export const financeQuery = (f: FinanceFilters): string =>
  Object.entries(f)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `&${k}=${encodeURIComponent(String(v))}`)
    .join("");

export interface Finance {
  month: string;
  resumo: { portasAtivas: number; custoCents: number; faturamentoCents: number; lucroCents: number; recebidoCents: number; emAbertoCents: number; pagos: number; semPreco: number };
  porPlano: { planId: string; plan: string; speedMbps: number; qtd: number; custoCents: number; faturamentoCents: number; lucroCents: number; margemPct: number | null }[];
  clientes: FinanceClient[];
}

export type OperationType = "bloqueio" | "desbloqueio" | "reinicio" | "cancelamento";
export type OperationState = "recebida" | "executando" | "concluida" | "parcial" | "sem_confirmacao" | "aguardando_equipe" | "falhou" | "aguardando_aprovacao" | "recusada";

export interface CustomerOperation {
  /** Motivo dado pela Speed quando recusa a operação. */
  decisionReason?: string | null;
  id: string;
  reservationId: string;
  type: OperationType;
  login: string;
  reason: string | null;
  state: OperationState;
  steps: { nome: string; estado: "pendente" | "concluida" | "falhou"; motivo?: string | null }[];
  createdAt: string;
  updatedAt: string;
}
