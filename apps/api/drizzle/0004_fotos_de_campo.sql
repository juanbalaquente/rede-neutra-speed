CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"contract" text,
	"kind" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"accuracy_m" double precision,
	"captured_at" timestamp with time zone,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_reservation_id_port_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."port_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photos_reservation_idx" ON "photos" USING btree ("reservation_id","kind");--> statement-breakpoint
CREATE INDEX "photos_partner_idx" ON "photos" USING btree ("partner_id","created_at");