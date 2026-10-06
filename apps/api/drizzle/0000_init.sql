CREATE TYPE "public"."partner_status" AS ENUM('ativo', 'bloqueado');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('ativa', 'convertida', 'cancelada', 'expirada');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('atendente', 'supervisor', 'admin_speed');--> statement-breakpoint
CREATE TABLE "api_call_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"system" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"duration_ms" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"partner_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"ip" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"cnpj" text NOT NULL,
	"status" "partner_status" DEFAULT 'ativo' NOT NULL,
	"max_active_reservations" integer DEFAULT 10 NOT NULL,
	"max_cto_occupancy_pct" integer DEFAULT 50 NOT NULL,
	"max_users" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_cnpj_unique" UNIQUE("cnpj")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"speed_mbps" integer NOT NULL,
	"speed_price_cents" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "port_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cto_name" text NOT NULL,
	"port" integer NOT NULL,
	"total_ports" integer,
	"address" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"status" "reservation_status" DEFAULT 'ativa' NOT NULL,
	"expires_at" timestamp with time zone,
	"contract_number" text,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "port_reservations_port_positive" CHECK ("port_reservations"."port" > 0),
	CONSTRAINT "port_reservations_active_has_expiry" CHECK ("port_reservations"."status" <> 'ativa' OR "port_reservations"."expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_partner" CHECK (("users"."role" = 'admin_speed' AND "users"."partner_id" IS NULL) OR ("users"."role" <> 'admin_speed' AND "users"."partner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "viability_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"viable" boolean NOT NULL,
	"reason" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "port_reservations" ADD CONSTRAINT "port_reservations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD CONSTRAINT "port_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD CONSTRAINT "port_reservations_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viability_queries" ADD CONSTRAINT "viability_queries_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viability_queries" ADD CONSTRAINT "viability_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_call_log_system_idx" ON "api_call_log" USING btree ("system","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_partner_idx" ON "audit_log" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "port_reservations_live_port_uq" ON "port_reservations" USING btree ("cto_name","port") WHERE "port_reservations"."status" IN ('ativa', 'convertida');--> statement-breakpoint
CREATE INDEX "port_reservations_partner_idx" ON "port_reservations" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "viability_queries_partner_idx" ON "viability_queries" USING btree ("partner_id","created_at");