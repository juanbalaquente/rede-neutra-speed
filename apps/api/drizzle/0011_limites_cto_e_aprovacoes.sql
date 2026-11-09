CREATE TABLE "cto_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid,
	"cto_id" text NOT NULL,
	"max_pct" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "customer_operations_open_idx";--> statement-breakpoint
ALTER TABLE "customer_operations" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_operations" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_operations" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "cto_lat" double precision;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "cto_lng" double precision;--> statement-breakpoint
ALTER TABLE "cto_limits" ADD CONSTRAINT "cto_limits_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cto_limits" ADD CONSTRAINT "cto_limits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cto_limits_partner_cto_idx" ON "cto_limits" USING btree ("partner_id","cto_id") WHERE "cto_limits"."partner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cto_limits_all_cto_idx" ON "cto_limits" USING btree ("cto_id") WHERE "cto_limits"."partner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "customer_operations" ADD CONSTRAINT "customer_operations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_operations_open_idx" ON "customer_operations" USING btree ("reservation_id","type") WHERE "customer_operations"."state" IN ('recebida', 'executando', 'parcial', 'aguardando_equipe', 'aguardando_aprovacao');