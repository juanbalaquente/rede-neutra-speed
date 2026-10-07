export type Role = "atendente" | "supervisor" | "admin_speed";

export interface User {
  id: string;
  partnerId: string | null;
  role: Role;
  name: string;
}

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

export interface Reservation {
  ctoId: string;
  id: string;
  ctoName: string;
  /** Reserva é por vaga; só reservas antigas têm número de porta. */
  port: number | null;
  address: string;
  status: "ativa" | "convertida" | "cancelada" | "expirada";
  expiresAt: string | null;
  createdAt: string;
  cancelReason: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

export const api = {
  login: (email: string, password: string) => request<{ user: User }>("POST", "/auth/login", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  me: () => request<{ user: User }>("GET", "/auth/me"),
  conferir: (days: number) => request<{ days: number; rows: ConferirRow[] }>("GET", `/admin/cto-conferir?days=${days}`),
  partner: () => request<{ partner: Partner | null }>("GET", "/partner"),
  viability: (address: string) => request<ViabilityResult>("POST", "/viability", { address }),
  reservations: () => request<{ reservations: Reservation[] }>("GET", "/reservations"),
  reserve: (input: { ctoId: string; address: string; lat?: number | null; lng?: number | null }) =>
    request<{ reservation: Reservation }>("POST", "/reservations", input),
  cancel: (id: string, reason?: string) => request<{ reservation: Reservation }>("POST", `/reservations/${id}/cancel`, { reason }),
};
