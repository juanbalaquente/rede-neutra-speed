ALTER TABLE "port_reservations" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "nickname" text;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "visit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "technician" text;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "visit_status" text DEFAULT 'agendada' NOT NULL;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "os_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "os_closed_by" uuid;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "os_data" jsonb;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD CONSTRAINT "port_reservations_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_reservations" ADD CONSTRAINT "port_reservations_os_closed_by_users_id_fk" FOREIGN KEY ("os_closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;