import { request } from "./api";

export type FibraEstado = "online" | "offline" | "loss" | "sem_energia" | "inativo" | "desabilitada" | "desconhecido";
export type AutenticacaoEstado = "conectado" | "desconectado" | "desconhecido";
export type ContratoEstado = "ativo" | "bloqueado" | "suspenso" | "cancelado" | "desconhecido";

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
    autenticacao: { estado: AutenticacaoEstado; ip: string | null; desde: string | null; atualizadoEm: string | null };
    contrato: { estado: ContratoEstado; desde: string | null; atualizadoEm: string | null };
    onu: { serial: string; modelo: string | null; olt: string | null; vlan: number | null } | null;
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

export const clientStatusApi = {
  status: (installationId: string, fresh = false) => request<ClientStatusView>("GET", `/installations/${installationId}/status${fresh ? "?fresh=true" : ""}`),
  signal: (installationId: string, days: number) => request<SignalView>("GET", `/installations/${installationId}/signal?days=${days}`),
  fleet: () => request<Fleet>("GET", "/dashboard/rede"),
};
