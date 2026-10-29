CREATE TABLE "customer_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"login" text NOT NULL,
	"reason" text,
	"idempotency_key" uuid NOT NULL,
	"wiki_operation_id" text,
	"state" text DEFAULT 'recebida' NOT NULL,
	"steps" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_operations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "customer_status" text DEFAULT 'ativo' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_operations" ADD CONSTRAINT "customer_operations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_operations" ADD CONSTRAINT "customer_operations_reservation_id_port_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."port_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_operations" ADD CONSTRAINT "customer_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_operations_reservation_idx" ON "customer_operations" USING btree ("reservation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_operations_open_idx" ON "customer_operations" USING btree ("reservation_id","type") WHERE "customer_operations"."state" IN ('recebida', 'executando', 'parcial', 'aguardando_equipe');