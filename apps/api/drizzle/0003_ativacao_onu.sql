CREATE TABLE "activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"wiki_activation_id" text,
	"cto_id" text NOT NULL,
	"serial" text NOT NULL,
	"contract" text NOT NULL,
	"ppp_login" text NOT NULL,
	"sinal_cto_dbm" double precision NOT NULL,
	"limite_db" double precision NOT NULL,
	"state" text DEFAULT 'recebida' NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "activations" ADD CONSTRAINT "activations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activations" ADD CONSTRAINT "activations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activations" ADD CONSTRAINT "activations_reservation_id_port_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."port_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activations_partner_idx" ON "activations" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activations_open_reservation_idx" ON "activations" USING btree ("reservation_id") WHERE "activations"."state" NOT IN ('cancelada', 'falhou');--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_code_unique" UNIQUE("code");