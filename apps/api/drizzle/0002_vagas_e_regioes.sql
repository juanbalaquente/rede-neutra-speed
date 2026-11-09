DROP INDEX "port_reservations_live_port_uq";--> statement-breakpoint
ALTER TABLE "port_reservations" ALTER COLUMN "port" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "allowed_regions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "port_reservations_live_cto_idx" ON "port_reservations" USING btree ("cto_id") WHERE "port_reservations"."status" IN ('ativa', 'convertida');