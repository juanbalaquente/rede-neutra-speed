import { request } from "./api";

export type TicketType = "cto_com_problema" | "porta_off" | "conferencia_porta" | "sinal_fora_padrao_cto" | "rompimento_regional" | "trava_sinal";
export type TicketState = "recebido" | "aberto" | "em_atendimento" | "aguardando_parceiro" | "resolvido" | "cancelado";

export interface TicketMessage {
  id: string;
  author: "parceiro" | "infra" | "sistema";
  body: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  origin: "parceiro" | "sistema";
  type: TicketType;
  typeLabel: string;
  state: TicketState;
  ctoName: string | null;
  login: string | null;
  description: string;
  signalDbm: number | null;
  slaHours: number;
  dueAt: string;
  late: boolean;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  partnerName: string | null;
}

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
  undelivered: boolean;
}

type SlaMap = Record<TicketType, number>;

export const ticketApi = {
  list: () => request<{ tickets: Ticket[] }>("GET", "/tickets"),
  get: (id: string) => request<{ ticket: TicketDetail }>("GET", `/tickets/${id}`),
  create: (input: { type: TicketType; description: string; reservationId?: string | null; ctoId?: string | null; signalDbm?: number | null }) =>
    request<{ ticket: TicketDetail }>("POST", "/tickets", input),
  message: (id: string, text: string) => request<{ ticket: TicketDetail }>("POST", `/tickets/${id}/messages`, { text }),
  retry: (id: string) => request<{ ticket: TicketDetail }>("POST", `/tickets/${id}/retry`),
  sla: () => request<{ sla: SlaMap; padrao: SlaMap }>("GET", "/admin/settings/sla"),
  setSla: (type: TicketType, hours: number) => request<{ sla: SlaMap; padrao: SlaMap }>("PUT", "/admin/settings/sla", { type, hours }),
};
