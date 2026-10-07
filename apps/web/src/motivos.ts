/** Motivos técnicos de "conferir". Só a Speed vê. */
export const MOTIVO: Record<string, string> = {
  cto_sem_id: "O Codemaps não trouxe id da CTO",
  cto_nao_encontrada: "Sem caixa no OLTCloud (ou caixa recriada)",
  mapa_sem_contagem: "O mapa não informou portas livres",
  mapa_diverge_ocupacao: "Mapa e ocupação divergem",
  dado_antigo: "Ocupação lida há mais de 1 hora",
  fonte_marcou_conferir: "A fonte marcou para conferência",
};

export const motivoLabel = (code: string) => MOTIVO[code] ?? code;
