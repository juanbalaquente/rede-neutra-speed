ALTER TABLE "port_reservations" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
-- Cancelamentos antigos: a melhor aproximação da data é a última atualização da reserva.
UPDATE "port_reservations" SET "cancelled_at" = "updated_at" WHERE "status" = 'cancelada' AND "cancelled_at" IS NULL;
