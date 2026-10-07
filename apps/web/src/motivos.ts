/** Motivos técnicos de "conferir". Só a Speed vê. */
export const MOTIVO: Record<string, string> = {
  cto_sem_id: "O Codemaps não trouxe id da CTO",
  cto_nao_encontrada: "Sem caixa no OLTCloud (ou caixa recriada)",
  mapa_sem_contagem: "O mapa não informou portas livres",
  mapa_diverge_ocupacao: "Mapa e ocupação divergem",
  dado_antigo: "Ocupação lida há mais de 1 hora",
  nome_repetido: "Nome repetido sem coincidência de coordenada",
  gemea_total_diferente: "Caixas gêmeas com total de portas diferente",
  gemea_nao_resolvida: "Caixa gêmea não resolvida",
  snapshot_antigo: "Leitura da Wiki desatualizada",
  fonte_marcou_conferir: "A fonte marcou para conferência",
};

export const motivoLabel = (code: string) => MOTIVO[code] ?? code;
