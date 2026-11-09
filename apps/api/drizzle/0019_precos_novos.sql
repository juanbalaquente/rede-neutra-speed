-- Tabela de valores da Speed por porta ativada (diretoria, 28 out 2026): 600 Mega R$ 40, 800 Mega R$ 50, 1 Giga R$ 70.
-- Vale para todos os parceiros e para os meses já fechados. O 700 Mega sai da venda; quem já tem continua cobrado.
-- Só registra na auditoria o que de fato muda (banco novo, sem planos, não grava nada).
INSERT INTO "audit_log" ("action", "entity", "entity_id", "data")
SELECT 'plano.preco_speed', 'plan', "id"::text,
  jsonb_build_object('plano', "name", 'before', "speed_price_cents", 'after', v.cents, 'origem', 'migration 0019_precos_novos')
FROM "plans" JOIN (VALUES (600, 4000), (800, 5000), (1000, 7000)) AS v(mbps, cents) ON "speed_mbps" = v.mbps
WHERE "speed_price_cents" <> v.cents;
--> statement-breakpoint
UPDATE "plans" SET "speed_price_cents" = v.cents
FROM (VALUES (600, 4000), (800, 5000), (1000, 7000)) AS v(mbps, cents)
WHERE "plans"."speed_mbps" = v.mbps AND "plans"."speed_price_cents" <> v.cents;
--> statement-breakpoint
INSERT INTO "audit_log" ("action", "entity", "entity_id", "data")
SELECT 'plano.fora_da_venda', 'plan', "id"::text, jsonb_build_object('plano', "name", 'origem', 'migration 0019_precos_novos')
FROM "plans" WHERE "speed_mbps" = 700 AND "active";
--> statement-breakpoint
UPDATE "plans" SET "active" = false WHERE "speed_mbps" = 700 AND "active";
