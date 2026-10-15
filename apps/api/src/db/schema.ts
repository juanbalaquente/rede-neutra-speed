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
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "users_role_partner",
      sql`(${t.role} = 'admin_speed' AND ${t.partnerId} IS NULL) OR (${t.role} <> 'admin_speed' AND ${t.partnerId} IS NOT NULL)`,
    ),
  ],
);

/** Planos vendáveis. A velocidade é controlada pelo RADIUS da Speed. */
export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  speedMbps: integer("speed_mbps").notNull(),
  /** Valor que a Speed cobra do parceiro por porta ativada, em centavos. */
  speedPriceCents: integer("speed_price_cents").notNull(),
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
    status: reservationStatus("status").notNull().default("ativa"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    contractNumber: text("contract_number"),
    cancelReason: text("cancel_reason"),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
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
export const PHOTO_KINDS = ["cto_aberta", "etiqueta_porta", "medicao", "sobra_fibra", "onu_instalada"] as const;
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
