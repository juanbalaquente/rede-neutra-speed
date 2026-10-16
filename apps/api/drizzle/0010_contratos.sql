CREATE TABLE "contract_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"wiki_operation_id" text,
	"state" text DEFAULT 'recebida' NOT NULL,
	"steps" jsonb,
	"contract" text,
	"login" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_requests_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "install_address" jsonb;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_reservation_id_port_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."port_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_requests_reservation_idx" ON "contract_requests" USING btree ("reservation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_requests_live_idx" ON "contract_requests" USING btree ("reservation_id") WHERE "contract_requests"."state" <> 'falhou';