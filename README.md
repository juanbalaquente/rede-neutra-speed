# Speed Rede Neutra

Portal onde um provedor parceiro vende e opera os próprios clientes na rede de fibra da Speed, sem acessar Voalle, OLTCloud ou Codemaps. O portal é uma camada de orquestração sobre esses sistemas: consome, orquestra e devolve só o recorte que o parceiro precisa.

Contexto completo do projeto (regras de negócio, decisões, visual aprovado e integração com a SpeedWiki) em [docs/CONTEXTO.md](docs/CONTEXTO.md).

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

## Ver funcionando (jeito mais rápido)

Precisa só do Docker Desktop aberto. No terminal (PowerShell no Windows):

```bash
git clone https://github.com/juanbalaquente/rede-neutra-speed
cd rede-neutra-speed
copy .env.example .env          # no Linux/Mac: cp .env.example .env
docker compose up -d --build
```

Abra http://localhost:8088 e entre com `atendente@demo.local` / `demo12345a`. A primeira subida demora alguns minutos (baixa as imagens e compila). Banco, migrations e usuários de demonstração sobem sozinhos. Para desligar: `docker compose down`. Se a porta 8088 já estiver em uso, troque `WEB_PORT` no `.env` e rode o `up` de novo. O banco não ocupa porta nenhuma do PC nesse modo.

## Rodar local para desenvolver

```bash
npm install
cp .env.example .env            # preencha SESSION_SECRET
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # banco em localhost:5433 (DB_PORT)
npm run db:migrate -w apps/api
npm run db:seed -w apps/api
npm run dev:api
npm run dev:web                 # http://localhost:5173
```

O seed cria em desenvolvimento: `admin@speed.local` / `admin12345a` (ou `SEED_ADMIN_PASSWORD`), e o parceiro de demonstração com `supervisor@demo.local` e `atendente@demo.local` / `demo12345a`. Em produção só cria o admin e exige `SEED_ADMIN_PASSWORD`.

Com `INTEGRATIONS_MODE=mock` o portal usa uma rede de exemplo (3 CTOs fictícias). Endereço começando com "sem viabilidade" simula um ponto sem cobertura.

Tudo em container: `docker compose up -d --build` (web em http://localhost:8088).

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

## Deploy em servidor

Servidor sugerido: Ubuntu Server LTS, 4 vCPU, 4 GB de RAM, 50 GB, IP fixo, `open-vm-tools` se for VM. Firewall liberando só 22, 80 e 443 (`ufw`), SSH por chave.

1. Crie o subdomínio (registro A) apontando para o IP público do servidor e libere 80/443 até ele. Peça à SpeedWiki para liberar o IP de saída do servidor.
2. Instale Docker Engine com o plugin Compose e clone o repositório em `/opt/rede-neutra`.
3. `cp .env.example .env` e preencha: `NODE_ENV=production`, `PORTAL_DOMAIN`, `SESSION_SECRET` (`openssl rand -hex 32`), `POSTGRES_PASSWORD`, `SEED_ADMIN_PASSWORD`, `INTEGRATIONS_MODE=wiki`, `WIKI_BASE_URL`, `WIKI_API_KEY`. `chmod 600 .env`.
4. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. O Caddy emite o certificado sozinho; o portal responde em `https://PORTAL_DOMAIN`.
5. Backup: agende `deploy/backup-db.sh` no cron (`0 3 * * *`) e copie `/opt/rede-neutra-backups` para outra máquina.
6. Fotos de campo ficam no volume `photos-data` (pasta `/data/photos` do container da API). O mesmo script de backup espelha esse volume em `$BACKUP_DIR/fotos`; copie o diretório de backup inteiro para outra máquina.
7. Atualizar: tire um snapshot da VM, `git pull` e repita o comando do passo 4.

## Ainda não feito

- Criação de contrato no Voalle com ponto de acesso, aceite e liberação de PPPoE (depende da validação no Voalle).
- Liberação de ONU: o portal já tem o fluxo completo (foto da medição, trava de sinal, decisão do técnico) contra um mock. Ligar no OLTCloud depende das rotas de escrita da SpeedWiki (`ACTIVATION_MODE=wiki`) e da autorização do Juan.
- Fotos: o painel de ativação envia as cinco fotos; faltam a O.S. (fechamento) e uma tela de consulta das fotos pela Speed.
- Agenda de visitas, tela do cliente, chamados para a SpeedWiki, financeiro e dashboards.
- Segundo fator para supervisor.
