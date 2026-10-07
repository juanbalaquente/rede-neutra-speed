# Speed Rede Neutra — contexto para o Claude

Portal do parceiro da rede neutra da Speed Fibra. Visão geral, como rodar e o que falta estão no README. **Antes de qualquer tarefa, leia `docs/CONTEXTO.md`**: regras de negócio, decisões já tomadas, estado do código, visual aprovado e integração com a SpeedWiki. A especificação original está em `docs/planejamento.pdf`.

- Monorepo npm workspaces: `apps/api` (Hono + Drizzle + Postgres) e `apps/web` (React + Vite).
- Imports relativos na API usam extensão `.js` (o build é NodeNext).
- Mudou `apps/api/src/db/schema.ts`? Gere a migration com `npm run db:generate -w apps/api -- --name <nome>` e commite a pasta `drizzle/`.
- Toda rota de dado do parceiro filtra por `partner_id` da sessão no servidor. Recurso de outro parceiro responde 404, nunca 403 (não revela que existe).
- Toda ação que mexe na rede ou no cadastro grava em `audit_log` via `recordAudit`.
- A CTO é identificada por `ctoId`, nunca pelo nome. Reserva é por vaga (não por porta); CTO sem caixa no OLTCloud, com dado velho ou fora das siglas liberadas ao parceiro não é oferecida. O contrato com a SpeedWiki está em `docs/CONTRATO-WIKI-V1.md` (`INTEGRATIONS_MODE=wiki`).
- Integrações ficam atrás das interfaces de `apps/api/src/integrations/types.ts`. Os clientes reais seguem o mesmo login e endpoints que a SpeedWiki (repo juanbalaquente/SpeedWiki) já usa em produção.
- Nunca escrever nos sistemas de origem (Voalle, OLTCloud, Codemaps) sem validação explícita com o usuário: são produção.
- `npm test` precisa passar antes de qualquer push.
- Comandos: `npm test` (vitest + PGlite, sem Docker), `npm run typecheck`, `npm run dev:api` e `npm run dev:web` (banco via `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db`), ou tudo em container com `docker compose up -d --build` (http://localhost:8088).
- Frontend segue o protótipo aprovado `docs/prototipo/modelo-4.html` (sidebar, busca Ctrl K, tema claro/escuro, fonte Geist, gráficos ricos). Identidade própria: não copiar a SpeedWiki nem o Speed Parceiros, nada de cara de "vibe code" (cards iguais com emoji, gradiente roxo, fade em tudo).
- Textos da interface, commits e documentação em português.
