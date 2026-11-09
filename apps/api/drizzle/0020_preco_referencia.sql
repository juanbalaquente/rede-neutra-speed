ALTER TABLE "plans" ADD COLUMN "reference_price_cents" integer;
--> statement-breakpoint
-- Preço da Speed ao cliente final (diretoria, 28 out 2026), mostrado ao parceiro como referência: 600 Mega R$ 99,90,
-- 800 Mega R$ 129,90, 1 Giga R$ 149,90. Banco novo, sem planos, não grava nada.
INSERT INTO "audit_log" ("action", "entity", "entity_id", "data")
SELECT 'plano.preco_referencia', 'plan', "id"::text,
  jsonb_build_object('plano', "name", 'before', "reference_price_cents", 'after', v.cents, 'origem', 'migration 0020_preco_referencia')
FROM "plans" JOIN (VALUES (600, 9990), (800, 12990), (1000, 14990)) AS v(mbps, cents) ON "speed_mbps" = v.mbps
WHERE "reference_price_cents" IS DISTINCT FROM v.cents;
--> statement-breakpoint
UPDATE "plans" SET "reference_price_cents" = v.cents
FROM (VALUES (600, 9990), (800, 12990), (1000, 14990)) AS v(mbps, cents)
WHERE "plans"."speed_mbps" = v.mbps AND "plans"."reference_price_cents" IS DISTINCT FROM v.cents;
