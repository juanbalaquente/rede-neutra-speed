/** Motivos técnicos de "conferir" (e informativos). Só a Speed vê. Código desconhecido aparece como veio. */
export const MOTIVO: Record<string, string> = {
  cto_sem_id: "O Codemaps não trouxe id da CTO",
  sem_caixa_oltcloud: "Sem caixa no OLTCloud (ou caixa recriada)",
  mapa_sem_contagem: "O mapa não informou vagas livres",
  vagas_acima_do_mapa: "Leitura com mais vagas livres que o mapa",
  dado_antigo: "Leitura há mais de 1 hora",
  snapshot_antigo: "Leitura da Wiki desatualizada",
  nome_repetido: "Nome repetido sem coincidência de coordenada",
  oltcloud_mais_clientes_que_desenho: "OLTCloud tem mais clientes que o diagrama (vagas descontadas)",
  fonte_marcou_conferir: "A fonte marcou para conferência",
};

export const motivoLabel = (code: string) => MOTIVO[code] ?? code;
