# Speed Rede Neutra

Portal onde um provedor parceiro vende e opera os próprios clientes na rede de fibra da Speed, sem acessar Voalle, OLTCloud ou Codemaps. O portal é uma camada de orquestração sobre esses sistemas: consome, orquestra e devolve só o recorte que o parceiro precisa.

## O que já existe

- Login com sessão em cookie httpOnly e três perfis: atendente, supervisor (do parceiro) e administrador Speed.
- Multi-parceiro desde o início: tudo do parceiro carrega `partner_id` e é filtrado no servidor. Um parceiro nunca vê dado de outro.
- Consulta de viabilidade: CTOs próximas, portas livres de verdade (descontando reservas do portal) e planos. Toda consulta é registrada, mesmo sem viabilidade.
- Reserva de porta por 48h com trava real no banco (índice único parcial), expiração automática, cancelamento pelo parceiro e pela Speed (com motivo), limite de reservas simultâneas e limite de ocupação por CTO (padrão 50%).
- Supervisor cria e desativa os próprios atendentes, dentro do limite definido pela Speed.
- Administração Speed (API): cadastro de parceiros, limites, bloqueio do parceiro inteiro (com motivo) e trilha de auditoria.
- Auditoria de toda ação e log de toda chamada aos sistemas de origem.

## Stack

TypeScript em monorepo (npm workspaces): `apps/api` (Node + Hono, Postgres + Drizzle) e `apps/web` (React + Vite). Mesma família de ferramentas da SpeedWiki.

## Rodar local

```bash
npm install
cp .env.example .env            # preencha SESSION_SECRET
docker compose up -d db
npm run db:migrate -w apps/api
npm run db:seed -w apps/api
npm run dev:api
npm run dev:web                 # http://localhost:5173
```

O seed cria em desenvolvimento: `admin@speed.local` / `admin12345a` (ou `SEED_ADMIN_PASSWORD`), e o parceiro de demonstração com `supervisor@demo.local` e `atendente@demo.local` / `demo12345a`. Em produção só cria o admin e exige `SEED_ADMIN_PASSWORD`.

Com `INTEGRATIONS_MODE=mock` o portal usa uma rede de exemplo (3 CTOs fictícias). Endereço começando com "sem viabilidade" simula um ponto sem cobertura.

Tudo em container: `docker compose up -d --build` (web em http://localhost:8080).

## Testes

```bash
npm test
```

Os testes sobem um Postgres em memória (PGlite), aplicam as migrations e exercitam a API de ponta a ponta: viabilidade, reserva, expiração, limites, cancelamento, isolamento entre parceiros, bloqueio de parceiro e trava de login.

## Integrações reais

`INTEGRATIONS_MODE=real` liga o Codemaps (endereço → CTOs) e o OLTCloud (ocupação porta a porta). Esses sistemas liberam acesso por IP, então só funcionam a partir de um servidor autorizado (hoje o da SpeedWiki).

Validação do caminho crítico, só leitura, nada é criado ou alterado:

```bash
npm run validate:integrations -w apps/api -- "Rua X, 100, Belo Horizonte"
```

O script confere login e leitura nos três sistemas, cruza a CTO do Codemaps com a ocupação do OLTCloud e procura no schema da API do OLTCloud as rotas de autorização de ONU.

## Ainda não feito

- Criação de contrato no Voalle com ponto de acesso, aceite e liberação de PPPoE (depende da validação no Voalle).
- Liberação de ONU pelo OLTCloud com trava de sinal (depende de existir rota de autorização na API).
- Telas de administração Speed e de gestão de usuários (a API já existe).
- Aviso de reserva perto de expirar, agenda de visitas, fotos e O.S., tela do cliente, chamados para a SpeedWiki, financeiro e dashboards.
- Segundo fator para supervisor.
