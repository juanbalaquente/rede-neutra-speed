CREATE TABLE "capacity_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cto_id" text NOT NULL,
	"cto_name" text NOT NULL,
	"regiao" text,
	"address" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"cto_lat" double precision,
	"cto_lng" double precision,
	"total_vagas" integer,
	"blocked_reason" text NOT NULL,
	"motivos" jsonb,
	"status" text DEFAULT 'pendente' NOT NULL,
	"decision_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reservation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capacity_requests" ADD CONSTRAINT "capacity_requests_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_requests" ADD CONSTRAINT "capacity_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_requests" ADD CONSTRAINT "capacity_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_requests" ADD CONSTRAINT "capacity_requests_reservation_id_port_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."port_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capacity_requests_partner_idx" ON "capacity_requests" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE INDEX "capacity_requests_status_idx" ON "capacity_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_requests_pending_uq" ON "capacity_requests" USING btree ("partner_id","cto_id","address") WHERE "capacity_requests"."status" = 'pendente';