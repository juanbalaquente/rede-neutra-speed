DROP INDEX "port_reservations_live_port_uq";--> statement-breakpoint
ALTER TABLE "port_reservations" ADD COLUMN "cto_id" text;--> statement-breakpoint
-- Reservas anteriores só têm o nome da CTO: ele vira o id delas (mesma limitação de antes).
UPDATE "port_reservations" SET "cto_id" = "cto_name";--> statement-breakpoint
ALTER TABLE "port_reservations" ALTER COLUMN "cto_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "port_reservations_live_port_uq" ON "port_reservations" USING btree ("cto_id","port") WHERE "port_reservations"."status" IN ('ativa', 'convertida');
