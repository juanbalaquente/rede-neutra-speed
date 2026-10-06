# Speed Rede Neutra — contexto para o Claude

Portal do parceiro da rede neutra da Speed Fibra. Visão geral, como rodar e o que falta estão no README.

- Monorepo npm workspaces: `apps/api` (Hono + Drizzle + Postgres) e `apps/web` (React + Vite).
- Imports relativos na API usam extensão `.js` (o build é NodeNext).
- Mudou `apps/api/src/db/schema.ts`? Gere a migration com `npm run db:generate -w apps/api -- --name <nome>` e commite a pasta `drizzle/`.
- Toda rota de dado do parceiro filtra por `partner_id` da sessão no servidor. Recurso de outro parceiro responde 404, nunca 403 (não revela que existe).
- Toda ação que mexe na rede ou no cadastro grava em `audit_log` via `recordAudit`.
- Integrações ficam atrás das interfaces de `apps/api/src/integrations/types.ts`. Os clientes reais seguem o mesmo login e endpoints que a SpeedWiki (repo juanbalaquente/SpeedWiki) já usa em produção.
- Nunca escrever nos sistemas de origem (Voalle, OLTCloud, Codemaps) sem validação explícita com o usuário: são produção.
- `npm test` precisa passar antes de qualquer push.
