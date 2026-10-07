export type Role = "atendente" | "supervisor" | "admin_speed";

export interface User {
  id: string;
  partnerId: string | null;
  role: Role;
  name: string;
}

export interface ViabilityCto {
  name: string;
  distanceM: number;
  totalPorts: number;
  freePorts: number[];
  blockedReason: "sem_porta_livre" | "limite_ocupacao" | "sem_dados_de_porta" | "conferir" | null;
}

export interface ViabilityResult {
  viable: boolean;
  point: { lat: number; lng: number } | null;
  ctos: ViabilityCto[];
  plans: { id: string; name: string; speedMbps: number }[];
}

export interface Reservation {
  id: string;
  ctoName: string;
  port: number;
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
  viability: (address: string) => request<ViabilityResult>("POST", "/viability", { address }),
  reservations: () => request<{ reservations: Reservation[] }>("GET", "/reservations"),
  reserve: (input: { ctoName: string; port: number; address: string; lat?: number | null; lng?: number | null }) =>
    request<{ reservation: Reservation }>("POST", "/reservations", input),
  cancel: (id: string, reason?: string) => request<{ reservation: Reservation }>("POST", `/reservations/${id}/cancel`, { reason }),
};
