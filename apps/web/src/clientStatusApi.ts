import { request } from "./api";

export type FibraEstado = "online" | "offline" | "loss" | "sem_energia" | "inativo" | "desabilitada" | "desconhecido";
export type AutenticacaoEstado = "conectado" | "desconectado" | "desconhecido";
export type ContratoEstado = "ativo" | "pendente_aprovacao" | "rejeitado" | "bloqueado" | "suspenso" | "cancelado" | "desconhecido";

export interface Referencia {
  sinalCtoDbm: number;
  limiteDb: number;
  /** Pior sinal aceitável na ONU: o medido na CTO menos o limite que valeu. */
  minimoDbm: number;
}

export interface ClientStatusView {
  status: {
    login: string;
    fibra: { estado: FibraEstado; sinalDbm: number | null; uptimeDesde: string | null; ultimaQuedaEm: string | null; atualizadoEm: string | null };
    autenticacao: { estado: AutenticacaoEstado; ip: string | null; desde: string | null; atualizadoEm: string | null; motivo?: string | null };
    contrato: { estado: ContratoEstado; desde: string | null; atualizadoEm: string | null };
    onu: { serial: string; modelo: string | null; olt: string | null; vlan: number | null } | null;
    /** Bloqueio feito pela Speed na ONU; ausente em respostas antigas. */
    bloqueio?: { ativo: boolean; desde: string | null; motivo: string | null };
  };
  fibraVelha: boolean;
  pppoeVelho: boolean;
  referencia: Referencia;
}

export interface SignalView {
  series: {
    login: string;
    dias: number;
    pontos: { em: string; rxDbm: number }[];
    quedas: { inicio: string; fim: string | null; tipo: "loss" | "sem_energia" | "offline" }[];
  };
  referencia: Referencia;
}

export interface FleetAlarm {
  reservationId: string;
  contract: string | null;
  nickname: string | null;
  login: string;
  motivo: "fibra_loss" | "fibra_offline" | "sem_energia" | "pppoe_caido";
}

export interface Fleet {
  total: number;
  fibraOnline: number;
  pppoeConectado: number;
  loss: number;
  offline: number;
  bloqueados: number;
  semDados: number;
  alarmes: FleetAlarm[];
  atualizadoEm: string | null;
}

export type OnuProblema = "falha_rede" | "sem_luz" | "sem_energia" | "offline" | "desabilitada" | "pppoe_caido" | "sinal_fraco";

export interface OnuItem {
  reservationId: string;
  contract: string | null;
  nickname: string | null;
  login: string;
  serial: string;
  ctoName: string;
  address: string;
  plan: string | null;
  fibra: FibraEstado;
  autenticacao: AutenticacaoEstado;
  sinalDbm: number | null;
  minimoDbm: number;
  bloqueado: boolean;
  problema: OnuProblema | null;
}

export interface OnuList {
  onus: OnuItem[];
  /** A Wiki não respondeu ao lote: a lista vem do portal, sem estado. */
  leituraIndisponivel: boolean;
  atualizadoEm: string | null;
}

export interface Achado {
  tom: "ok" | "warn" | "bad" | "mute";
  codigo: string;
  titulo: string;
  texto: string;
  acao: "chamado" | "reiniciar" | "desbloquear" | null;
}

export interface OnuDetailView {
  cliente: { reservationId: string; contract: string | null; nickname: string | null; ctoName: string; address: string; login: string; customerStatus: "ativo" | "bloqueado" | "cancelado" };
  status: ClientStatusView["status"] | null;
  detalhe: {
    login: string;
    lidoEm: string | null;
    onu: {
      serial: string;
      modelo: string | null;
      estado: FibraEstado;
      olt: string | null;
      slot: number | null;
      pon: number | null;
      rxDbm: number | null;
      txDbm: number | null;
      rxOltDbm: number | null;
      temperaturaC: number | null;
      distanciaM: number | null;
      ligadaDesde: string | null;
      ultimaQuedaEm: string | null;
      sinalLidoEm: string | null;
    };
    pon: { onus: number; offline: number; mediaRxDbm: number | null } | null;
    wifi: { online: boolean; lidoEm: string | null; dispositivos: { nome: string | null; mac: string; banda: string | null; ssid: string | null; rssiDbm: number | null; online: boolean }[] } | null;
  } | null;
  detalheProblema: null | "rota_ausente" | "falhou";
  referencia: Referencia;
  diagnostico: Achado[];
}

export const clientStatusApi = {
  status: (installationId: string, fresh = false) => request<ClientStatusView>("GET", `/installations/${installationId}/status${fresh ? "?fresh=true" : ""}`),
  signal: (installationId: string, days: number) => request<SignalView>("GET", `/installations/${installationId}/signal?days=${days}`),
  fleet: () => request<Fleet>("GET", "/dashboard/rede"),
  onus: () => request<OnuList>("GET", "/onus"),
  onu: (installationId: string) => request<OnuDetailView>("GET", `/onus/${installationId}`),
};
