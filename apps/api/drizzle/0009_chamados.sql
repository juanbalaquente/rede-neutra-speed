CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid,
	"origin" text DEFAULT 'parceiro' NOT NULL,
	"type" text NOT NULL,
	"reservation_id" uuid,
	"cto_id" text,
	"cto_name" text,
	"login" text,
	"description" text NOT NULL,
	"signal_dbm" double precision,
	"sla_hours" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'recebido' NOT NULL,
	"wiki_ticket_id" text,
	"idempotency_key" uuid NOT NULL,
	"photo_ids" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reservation_id_port_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."port_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_source_idx" ON "ticket_messages" USING btree ("ticket_id","source_key");--> statement-breakpoint
CREATE INDEX "tickets_partner_idx" ON "tickets" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_state_idx" ON "tickets" USING btree ("state");