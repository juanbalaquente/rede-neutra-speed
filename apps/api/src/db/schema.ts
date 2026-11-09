import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["atendente", "supervisor", "admin_speed"]);
export const partnerStatus = pgEnum("partner_status", ["ativo", "bloqueado"]);
export const reservationStatus = pgEnum("reservation_status", ["ativa", "convertida", "cancelada", "expirada"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Contratante (provedor parceiro). Tudo que é dele carrega partner_id. */
export const partners = pgTable("partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  cnpj: text("cnpj").notNull().unique(),
  /** Código curto do provedor (ex.: JHV), definido pela Speed. Monta o login PPPoE: `<contrato>-<código>`. */
  code: text("code").unique(),
  status: partnerStatus("status").notNull().default("ativo"),
  /** Reservas simultâneas permitidas (evita travar CTOs sem vender). */
  maxActiveReservations: integer("max_active_reservations").notNull().default(10),
  /** % máximo das vagas de uma mesma CTO que o parceiro pode ocupar. */
  maxCtoOccupancyPct: integer("max_cto_occupancy_pct").notNull().default(50),
  /** Quantos usuários ativos o parceiro pode ter. */
  maxUsers: integer("max_users").notNull().default(10),
  /**
   * Siglas de região (R1, ITA, FAT...) que o parceiro pode vender, definidas pela Speed.
   * Vazio = nenhuma CTO é oferecida (liberação explícita, nunca por omissão).
   */
  allowedRegions: text("allowed_regions").array().notNull().default(sql`'{}'::text[]`),
  /**
   * Contrato que libera toda a rede da Speed: qualquer CTO com sigla no nome é oferecida,
   * e `allowedRegions` é ignorada. Ligado só pela Speed, de propósito (padrão: false).
   */
  allRegions: boolean("all_regions").notNull().default(false),
  createdAt: createdAt(),
});

/** Usuários do portal. admin_speed não pertence a parceiro; os outros pertencem. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").references(() => partners.id),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    active: boolean("active").notNull().default(true),
    /** Segredo TOTP cifrado (AES-GCM). Nulo = nunca configurou o segundo fator. */
    totpSecretEnc: text("totp_secret_enc"),
    /** Só vale depois de o usuário confirmar um código; antes disso o segredo é "pendente". */
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    /** Último intervalo de 30 s aceito: o mesmo código não entra duas vezes (replay). */
    totpLastStep: integer("totp_last_step"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "users_role_partner",
      sql`(${t.role} = 'admin_speed' AND ${t.partnerId} IS NULL) OR (${t.role} <> 'admin_speed' AND ${t.partnerId} IS NOT NULL)`,
    ),
  ],
);

/** Códigos de recuperação do segundo fator: uso único, guardados só como hash. */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

/** Planos vendáveis. A velocidade é controlada pelo RADIUS da Speed. */
export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  speedMbps: integer("speed_mbps").notNull(),
  /** Valor que a Speed cobra do parceiro por porta ativada, em centavos. */
  speedPriceCents: integer("speed_price_cents").notNull(),
  /** Quanto a própria Speed cobra do cliente final nesse plano, em centavos. Só referência para o parceiro; null = não mostra. */
  referencePriceCents: integer("reference_price_cents"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

/** Toda consulta fica registrada, mesmo sem viabilidade (demanda reprimida). */
export const viabilityQueries = pgTable(
  "viability_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").references(() => partners.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    address: text("address").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    viable: boolean("viable").notNull(),
    reason: text("reason"),
    result: jsonb("result"),
    createdAt: createdAt(),
  },
  (t) => [index("viability_queries_partner_idx").on(t.partnerId, t.createdAt)],
);

/**
 * Reserva de vaga na CTO. Vive só no portal (o Codemaps não tem reserva).
 * A trava é a contagem de reservas vivas da CTO contra as vagas livres, feita sob
 * lock por CTO (pg_advisory_xact_lock) na transação de reserva.
 */
export const portReservations = pgTable(
  "port_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** Id estável da caixa (chave da reserva). O nome repete e não identifica a CTO. */
    ctoId: text("cto_id").notNull(),
    /** Só para exibição, como a fonte devolveu na hora da reserva. */
    ctoName: text("cto_name").notNull(),
    /** Reserva é por VAGA na CTO; o número da porta não importa. Só reservas antigas têm porta. */
    port: integer("port"),
    /** Total de vagas (saídas de splitter) da CTO na hora da reserva. */
    totalPorts: integer("total_ports"),
    address: text("address").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** Posição da CTO na hora da reserva (para o link de rota do técnico). */
    ctoLat: doublePrecision("cto_lat"),
    ctoLng: doublePrecision("cto_lng"),
    status: reservationStatus("status").notNull().default("ativa"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    contractNumber: text("contract_number"),
    /** Dados do cliente, preenchidos pelo parceiro depois de reservar (planejamento, etapa 3). */
    planId: uuid("plan_id").references(() => plans.id),
    /** Nome do assinante final: só para busca e exibição no portal, nunca vai para o Voalle. */
    nickname: text("nickname"),
    visitAt: timestamp("visit_at", { withTimezone: true }),
    /** manha | tarde. O `visitAt` guarda só um horário de referência do período (8h ou 14h). Nulo em visitas antigas. */
    visitPeriod: text("visit_period"),
    technician: text("technician"),
    /** agendada | em_execucao | concluida | reagendada (etapa 4). */
    visitStatus: text("visit_status").notNull().default("agendada"),
    /** Fechamento da O.S.: quando, por quem e o que o técnico confirmou (porta, sinal final, ONU, observação). */
    osClosedAt: timestamp("os_closed_at", { withTimezone: true }),
    osClosedBy: uuid("os_closed_by").references(() => users.id),
    osData: jsonb("os_data"),
    /** Situação do contrato do cliente final no portal: ativo | bloqueado | cancelado (o bloqueio por inadimplência não libera a porta). */
    customerStatus: text("customer_status").notNull().default("ativo"),
    /** Endereço estruturado da instalação (cep, rua, número, bairro, cidade, UF), pedido para criar o contrato. */
    installAddress: jsonb("install_address"),
    cancelReason: text("cancel_reason"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    /** Quando foi cancelada: o fechamento do mês cobra a porta em todo mês em que ela esteve ativa (a cobrança é do portal, não do ERP). */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("port_reservations_live_cto_idx")
      .on(t.ctoId)
      .where(sql`${t.status} IN ('ativa', 'convertida')`),
    index("port_reservations_partner_idx").on(t.partnerId, t.status),
    check("port_reservations_port_positive", sql`${t.port} > 0`),
    check(
      "port_reservations_active_has_expiry",
      sql`${t.status} <> 'ativa' OR ${t.expiresAt} IS NOT NULL`,
    ),
  ],
);

/** Tipos de foto do fluxo de instalação. A da medição na CTO é exigida antes de pedir a ativação. */
export const PHOTO_KINDS = ["medicao", "cto_aberta", "etiqueta_porta", "medicao_onu", "sobra_fibra", "onu_instalada"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

/**
 * Metadados das fotos de campo; o arquivo fica no armazenamento (volume), só pela chave.
 * created_at é a hora do servidor (confiável); captured_at é a do aparelho (informativa).
 */
export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    reservationId: uuid("reservation_id").notNull().references(() => portReservations.id),
    /** Contrato da reserva na hora do envio, para a foto carregar a identificação mesmo se a reserva mudar. */
    contract: text("contract"),
    kind: text("kind").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    accuracyM: doublePrecision("accuracy_m"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    storageKey: text("storage_key").notNull().unique(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("photos_reservation_idx").on(t.reservationId, t.kind), index("photos_partner_idx").on(t.partnerId, t.createdAt)],
);

/** Preço de venda que o parceiro cobra do cliente final, por plano (centavos). Só o parceiro o define e vê. */
export const partnerPrices = pgTable(
  "partner_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    planId: uuid("plan_id").notNull().references(() => plans.id),
    priceCents: integer("price_cents").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("partner_prices_unique_idx").on(t.partnerId, t.planId), check("partner_prices_positive", sql`${t.priceCents} > 0`)],
);

/** Confirmação manual de pagamento do cliente final, mês a mês (aba financeira, primeira entrega). */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    reservationId: uuid("reservation_id").notNull().references(() => portReservations.id),
    /** AAAA-MM. */
    month: text("month").notNull(),
    paid: boolean("paid").notNull(),
    markedBy: uuid("marked_by").references(() => users.id),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payments_unique_idx").on(t.reservationId, t.month), index("payments_partner_month_idx").on(t.partnerId, t.month)],
);

/**
 * Automações sobre o cliente final (bloquear, desbloquear, reiniciar, cancelar). A execução é da Wiki
 * (contrato v3); aqui fica o pedido, o estado e as etapas, nunca segredo nem saída crua de equipamento.
 */
export const customerOperations = pgTable(
  "customer_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    reservationId: uuid("reservation_id").notNull().references(() => portReservations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** bloqueio | desbloqueio | reinicio | cancelamento */
    type: text("type").notNull(),
    login: text("login").notNull(),
    reason: text("reason"),
    /** Mesma chave a cada tentativa: a Wiki continua de onde parou, sem refazer o que já concluiu. */
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    wikiOperationId: text("wiki_operation_id"),
    /** recebida | executando | concluida | parcial | sem_confirmacao | aguardando_equipe | falhou */
    state: text("state").notNull().default("recebida"),
    steps: jsonb("steps"),
    /** Motivo que a Wiki manda com a operação em andamento (ex.: sistema_externo_indisponivel). Some quando volta. */
    wikiNote: text("wiki_note"),
    /** Aprovação da Speed (quando o tipo exige): quem decidiu, quando e o motivo da recusa. */
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customer_operations_reservation_idx").on(t.reservationId, t.createdAt),
    // Uma operação em andamento por reserva e tipo: dois cliques não viram duas ordens.
    uniqueIndex("customer_operations_open_idx")
      .on(t.reservationId, t.type)
      .where(sql`${t.state} IN ('recebida', 'executando', 'parcial', 'aguardando_equipe', 'aguardando_aprovacao')`),
  ],
);

/** Limite de ocupação por CTO (planejamento: "por parceiro e por CTO"). Vale no lugar do percentual do parceiro. partner_id nulo = todos os parceiros. */
export const ctoLimits = pgTable(
  "cto_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").references(() => partners.id),
    ctoId: text("cto_id").notNull(),
    /** Percentual máximo das vagas da CTO que o parceiro pode ocupar. 100 = liberada caso a caso. */
    maxPct: integer("max_pct").notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("cto_limits_partner_cto_idx").on(t.partnerId, t.ctoId).where(sql`${t.partnerId} IS NOT NULL`),
    uniqueIndex("cto_limits_all_cto_idx").on(t.ctoId).where(sql`${t.partnerId} IS NULL`),
  ],
);

/** Criação do contrato no Voalle pela Wiki (contrato v3, seção H). O número e o login nascem daqui. */
export const contractRequests = pgTable(
  "contract_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    reservationId: uuid("reservation_id").notNull().references(() => portReservations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    wikiOperationId: text("wiki_operation_id"),
    /** recebida | executando | concluida | parcial | aguardando_equipe | falhou | abandonada (decisão da Speed, portal apenas) */
    state: text("state").notNull().default("recebida"),
    steps: jsonb("steps"),
    /** Preenchidos quando a Wiki conclui: número do contrato e login PPPoE. */
    contract: text("contract"),
    login: text("login"),
    /** Motivo da recusa ou da falha, em texto curto. */
    reason: text("reason"),
    /**
     * Cancelamento no Voalle de um contrato abandonado. null = nada a cancelar (o pedido nem chegou à Wiki);
     * pendente_envio = a Wiki não recebeu ainda; depois, o estado da operação da Wiki; manual = a Speed confirmou à mão.
     */
    cancelKey: uuid("cancel_key"),
    cancelOperationId: text("cancel_operation_id"),
    cancelState: text("cancel_state"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contract_requests_reservation_idx").on(t.reservationId, t.createdAt),
    // Um contrato por reserva, salvo se o pedido anterior falhou ou foi abandonado: dois cliques não viram dois contratos no Voalle.
    uniqueIndex("contract_requests_live_idx").on(t.reservationId).where(sql`${t.state} NOT IN ('falhou', 'abandonada')`),
  ],
);

/** Motivos de chamado de infraestrutura (planejamento) mais o automático da trava de sinal. */
export const TICKET_TYPES = ["cto_com_problema", "porta_off", "conferencia_porta", "sinal_fora_padrao_cto", "rompimento_regional", "trava_sinal"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_STATES = ["recebido", "aberto", "em_atendimento", "aguardando_parceiro", "resolvido", "cancelado"] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/**
 * Chamado de infraestrutura. Nasce no portal e a Wiki (fila da Infra) o atende (contrato v3).
 * "recebido" = guardado no portal, ainda não entregue à Wiki (integração desligada ou fora do ar).
 */
export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    userId: uuid("user_id").references(() => users.id),
    /** parceiro | sistema (trava de sinal). */
    origin: text("origin").notNull().default("parceiro"),
    type: text("type").notNull(),
    reservationId: uuid("reservation_id").references(() => portReservations.id),
    ctoId: text("cto_id"),
    ctoName: text("cto_name"),
    login: text("login"),
    description: text("description").notNull(),
    signalDbm: doublePrecision("signal_dbm"),
    /** Prazo de atendimento, vindo da configuração de SLA do tipo no momento da abertura. */
    slaHours: integer("sla_hours").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    state: text("state").notNull().default("recebido"),
    wikiTicketId: text("wiki_ticket_id"),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    /** Ids das fotos anexadas (o portal gera os links assinados na hora do envio). */
    photoIds: jsonb("photo_ids"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tickets_partner_idx").on(t.partnerId, t.createdAt), index("tickets_state_idx").on(t.state)],
);

/** Histórico do chamado. As mensagens da Infra vêm da Wiki; dedupe pela chave de origem. */
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    /** parceiro | infra | sistema. */
    author: text("author").notNull(),
    body: text("body").notNull(),
    /** Chave de dedupe (hash de em|autor|texto) para mensagens que vêm da Wiki; nula para as locais. */
    sourceKey: text("source_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId, t.createdAt), uniqueIndex("ticket_messages_source_idx").on(t.ticketId, t.sourceKey)],
);

/** Parâmetros da Speed editáveis em tela (ex.: limite da trava de sinal). Cada mudança vai para a auditoria. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Liberação de ONU (contrato v2 com a Wiki). Identifica a ONU pela serial, nunca pelo id do
 * OLTCloud (muda a cada reautorização). Não guarda a saída do script de provisionamento:
 * ela traz a senha PPPoE em texto puro.
 */
export const activations = pgTable(
  "activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    reservationId: uuid("reservation_id").notNull().references(() => portReservations.id),
    /** Chave de idempotência enviada à Wiki: a mesma chave nunca gera uma segunda ativação. */
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    /** Id da ativação do lado da Wiki, preenchido na resposta ao POST. */
    wikiActivationId: text("wiki_activation_id"),
    ctoId: text("cto_id").notNull(),
    serial: text("serial").notNull(),
    contract: text("contract").notNull(),
    pppLogin: text("ppp_login").notNull(),
    /** Sinal medido pelo técnico na CTO (dBm) e limite que valeu para esta ativação (dB). */
    sinalCtoDbm: doublePrecision("sinal_cto_dbm").notNull(),
    limiteDb: doublePrecision("limite_db").notNull(),
    state: text("state").notNull().default("recebida"),
    /** Última leitura devolvida pela Wiki (sinal, prazo, motivo). */
    snapshot: jsonb("snapshot"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activations_partner_idx").on(t.partnerId, t.createdAt),
    // Uma ativação em andamento por reserva; terminadas (online, cancelada, falhou) liberam para nova tentativa.
    uniqueIndex("activations_open_reservation_idx")
      .on(t.reservationId)
      .where(sql`${t.state} NOT IN ('cancelada', 'falhou')`),
  ],
);

/** Trilha de auditoria: toda ação que mexe na rede ou no cadastro. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    partnerId: uuid("partner_id"),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    ip: text("ip"),
    data: jsonb("data"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_partner_idx").on(t.partnerId, t.createdAt)],
);

/**
 * Pedido de vaga numa CTO cheia, em "conferir" ou no limite do parceiro. Não ocupa vaga nem passa
 * pela trava: a Speed decide e, ao confirmar, nasce uma reserva normal de 48 h (a Speed estende a rede se precisar).
 */
export const capacityRequests = pgTable(
  "capacity_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id").notNull().references(() => partners.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    ctoId: text("cto_id").notNull(),
    ctoName: text("cto_name").notNull(),
    regiao: text("regiao"),
    address: text("address").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    ctoLat: doublePrecision("cto_lat"),
    ctoLng: doublePrecision("cto_lng"),
    totalVagas: integer("total_vagas"),
    /** Por que a CTO não podia ser reservada na hora do pedido (sem_vaga_livre, limite_ocupacao, conferir). */
    blockedReason: text("blocked_reason").notNull(),
    motivos: jsonb("motivos"),
    /** pendente | confirmado | recusado | cancelado */
    status: text("status").notNull().default("pendente"),
    decisionNote: text("decision_note"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Reserva criada quando a Speed confirmou. */
    reservationId: uuid("reservation_id").references(() => portReservations.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("capacity_requests_partner_idx").on(t.partnerId, t.createdAt),
    index("capacity_requests_status_idx").on(t.status, t.createdAt),
    uniqueIndex("capacity_requests_pending_uq").on(t.partnerId, t.ctoId, t.address).where(sql`${t.status} = 'pendente'`),
  ],
);

/** Log de toda chamada aos sistemas de origem, para depuração. */
export const apiCallLog = pgTable(
  "api_call_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    system: text("system").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    status: integer("status"),
    durationMs: integer("duration_ms").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("api_call_log_system_idx").on(t.system, t.createdAt)],
);
