# Speed Rede Neutra — contexto completo

Documento para quem chega agora ao projeto, em especial um Claude que está trabalhando no repositório da **SpeedWiki** (`juanbalaquente/SpeedWiki`) e precisa entender o Rede Neutra para integrar os dois. Atualizado em 6 out 2026.

Arquivos que acompanham este documento, na mesma pasta `docs/`:

- [`planejamento.pdf`](planejamento.pdf): especificação funcional original (19 páginas, @Guilherme, 5 out 2026). É a fonte das regras de negócio.
- [`prototipo/modelo-4.html`](prototipo/modelo-4.html): protótipo visual aprovado. Arquivo único, abre direto no navegador, só dados de exemplo.

---

## 1. O que é

Portal web onde um **provedor parceiro** vende e opera os próprios clientes usando a fibra da Speed, sem nunca acessar Voalle, OLTCloud ou Codemaps. Modelo de rede neutra parecido com o da V.tal, mas com toda a infraestrutura da Speed (CTO, fibra, OLT, concentrador, RADIUS). O parceiro paga **por porta ativada**, sem pacote fechado.

O portal é uma **camada de orquestração**: consome os sistemas da Speed por API, executa automações e devolve ao parceiro só o recorte que ele precisa. Não substitui nenhum sistema.

O que é dado próprio do portal: reservas de porta, fotos, preços de venda do parceiro, auditoria e conferência financeira. O resto vive nos sistemas de origem.

Piloto com **um parceiro** (um cliente que já compra link da Speed), mas multi-parceiro com isolamento total desde o primeiro dia.

## 2. Conceitos e regras de negócio

- **Chave única = número do contrato Voalle**, padrão `CONTRATO-PRIMEIRONOME`. O mesmo código identifica a porta na CTO, o registro no Codemaps, o cadastro no OLTCloud e o usuário PPPoE. Toda busca parte dele.
- **Contratos no nome do parceiro.** Juridicamente o cliente da Speed é o parceiro. O portal tem um campo livre de *apelido* para o nome do assinante final, que nunca vai para o Voalle.
- **Perfis:**
  - *Atendente* (do parceiro): viabilidade, reserva, contrato, agenda, liberação de ONU, chamado, bloqueio/desbloqueio.
  - *Supervisor* (do parceiro): tudo do atendente + dashboards, financeiro, preços de venda, gestão dos próprios usuários. Deve ter segundo fator.
  - *Administrador Speed*: cadastra parceiros, define limites e preços, vê auditoria, bloqueia um parceiro inteiro.
- **Fluxo de um cliente (etapas do PDF):**
  1. Viabilidade no Codemaps (CTOs próximas, portas livres de verdade, planos). Toda consulta é registrada, mesmo sem viabilidade (mostra demanda reprimida).
  2. Reserva da porta por **48 h**, só no banco do portal (o Codemaps não tem reserva). Expira sozinha, pode ser cancelada, tem limite de reservas simultâneas.
  3. Contrato no Voalle por automação: cria no nome do parceiro, vincula CTO/porta, gera PPPoE, **preenche o ponto de acesso (concentrador)** e devolve o número do contrato. O parceiro dá o aceite no portal, a automação aprova no Voalle e o portal mostra PPPoE e senha.
  4. Agenda de visita (calendário) e envio do roteiro ao técnico por WhatsApp (módulo opcional, instância separada do parceiro, não usa o Omni da Speed).
  5. Liberação da ONU pelo OLTCloud: técnico busca a SN entre as não autorizadas, o portal valida o sinal, autoriza, mostra a VLAN e confirma que a ONU subiu e o PPPoE autenticou. **Trava de sinal:** se o sinal medido diferir mais de **1,5** da média da CTO, só prossegue com justificativa, que abre chamado automático para a Infra.
  6. Fotos (CTO aberta, etiqueta da porta, medição, sobra de fibra, ONU instalada) com data, hora, GPS e contrato, e fechamento da O.S.
- **Tela do cliente (semáforo de 3 estados):** Fibra (OLTCloud), Autenticação PPPoE (Voalle/RADIUS) e Situação do contrato (Voalle). Fibra verde com PPPoE vermelho é cadastro; fibra vermelha é problema físico.
- **Automações sobre o cliente:** bloqueio por inadimplência (bloqueio administrativo no Voalle é o preferido), desbloqueio, reinício de ONU, troca de senha PPPoE, cancelamento (encerra contrato, remove ONU, devolve porta).
- **Proteção da rede:** limite de ocupação por CTO por parceiro (sugerido **50%**), limite de reservas simultâneas, auditoria de tudo que mexe na rede ou no cadastro.
- **Preços (referência):** 600 Mega, Speed recebe R$ 40,00, parceiro vende a R$ 99,90. Tabela fixa por plano é a recomendação do PDF.

## 3. Fases

- **Fase 1 (MVP, primeiro cliente de ponta a ponta):** login e perfis, viabilidade, reserva, contrato Voalle com ponto de acesso, liberação de ONU com trava de sinal, tela do cliente, painel admin básico.
- **Fase 2 (operação diária):** calendário, fotos e O.S., histórico de sinal e alarmes, bloqueio/desbloqueio/reinício, **chamados para a SpeedWiki**, preços de venda e dashboard operacional.
- **Fase 3:** financeiro e relatórios, módulo WhatsApp, limites por CTO configuráveis, segundo parceiro.

**Caminho crítico:** validar por API, em ambiente de teste, a criação de contrato no Voalle com ponto de acesso e a liberação de ONU no OLTCloud. Se alguma das duas não existir, o desenho muda.

## 4. Decisões já tomadas (6 out 2026)

- **Projeto separado da SpeedWiki**, com repositório, banco e deploy próprios. Vai conversar com a Wiki por integração, nunca morar dentro dela.
- **Começar direto pelo código.** Stack da mesma família da Wiki para facilitar a integração (ver seção 5).
- **Integração no modelo do SpeedParceiros:** serviço separado + rotas `/proxy/<algo>/*` na SpeedWiki com chave de API dedicada.
- **Reserva vive só no portal**; o Codemaps só é atualizado na ativação (opção mais simples sugerida pelo PDF).
- **Identidade visual própria**, sem herdar a SpeedWiki nem o Speed Parceiros (ver seção 7). Isso substitui a linha "segue a identidade da Speed, laranja e azul-marinho" do PDF: a marca Speed aparece, mas o produto tem cara própria.
- **App mobile no futuro:** React Native + Expo, focado no técnico (câmera, GPS, assinatura, push), um app só da Speed com login por parceiro. Antes disso, o portal pode virar PWA. A Speed já tem contas de desenvolvedor na Apple e na Play Store.

## 5. Stack e estrutura do repositório

Repositório `juanbalaquente/rede-neutra-speed` (privado), branch `main`.

- Monorepo npm workspaces, TypeScript.
- `apps/api`: Node + **Hono**, Postgres + **Drizzle**, sessão em cookie httpOnly (jose), senhas com bcrypt, validação com zod. Imports relativos com extensão `.js` (build NodeNext).
- `apps/web`: React 19 + Vite. Hoje três telas simples (login, viabilidade, reservas), ainda sem o visual aprovado.
- Testes: vitest + **PGlite** (Postgres em memória), ponta a ponta na API. `npm test` precisa passar antes de qualquer push.
- Docker Compose: `docker compose up -d --build` sobe banco, API e web em http://localhost:8088. O banco não expõe porta no PC; `docker-compose.dev.yml` expõe para desenvolvimento.

Arquivos que valem a leitura primeiro:

| Arquivo | O que tem |
|---|---|
| `CLAUDE.md` | regras do repositório (isolamento por `partner_id`, 404 em vez de 403, auditoria, nunca escrever nos sistemas de origem sem validação) |
| `apps/api/src/db/schema.ts` | tabelas: `partners`, `users`, `plans`, `viability_queries`, `port_reservations`, `audit_log`, `api_call_log` |
| `apps/api/src/app.ts` | todas as rotas HTTP |
| `apps/api/src/integrations/types.ts` | interfaces que o portal espera dos sistemas da Speed |
| `apps/api/src/integrations/{codemaps,oltcloud,voalle}.ts` | clientes reais, só leitura, mesmo login e endpoints que a SpeedWiki usa |
| `apps/api/src/scripts/validate-integrations.ts` | validação do caminho crítico, só leitura |

Rotas da API hoje: `/health`, `/auth/login|logout|me`, `POST /viability`, `GET|POST /reservations`, `POST /reservations/:id/cancel`, `GET /plans`, `GET|POST /users`, `POST /users/:id/active`, e sob `/admin`: `GET|POST /partners`, `PATCH /partners/:id`, `GET /audit`.

Variáveis de integração (`.env.example`): `INTEGRATIONS_MODE` (`mock` ou `real`), `CODEMAPS_TOKEN`, `CODEMAPS_SECRET`, `OLTCLOUD_BASE`, `OLTCLOUD_USER`, `OLTCLOUD_PASS`, `VOALLE_ERP_URL`, `VOALLE_CLIENT_ID`, `VOALLE_CLIENT_SECRET`, `VOALLE_SYNDATA`. São as mesmas credenciais que a SpeedWiki já usa.

## 6. Estado do código

**Pronto e testado (18 testes):**

- Login, sessão, três perfis, trava de tentativas de login.
- Isolamento por `partner_id` validado no servidor; recurso de outro parceiro responde 404.
- Viabilidade: CTOs próximas, portas livres descontando reservas do portal, planos. Toda consulta registrada.
- Reserva 48 h com trava real no banco (índice único parcial em `cto_name + port` para status `ativa`/`convertida`), expiração, cancelamento pelo parceiro e pela Speed com motivo, limite de reservas simultâneas, limite de 50% por CTO.
- Supervisor cria e desativa os próprios atendentes dentro do limite.
- Admin Speed (só API): parceiros, limites, bloqueio do parceiro inteiro, auditoria.
- `audit_log` em toda ação e `api_call_log` em toda chamada a sistema de origem.
- Clientes reais de Codemaps (endereço → CTOs), OLTCloud (ocupação porta a porta) e Voalle (só autenticação), **nunca testados contra os sistemas reais**, porque eles liberam acesso por IP e só o servidor da SpeedWiki está liberado.

**Ainda não feito:**

- Contrato no Voalle com ponto de acesso, aceite e PPPoE.
- Liberação de ONU no OLTCloud com trava de sinal.
- Telas de admin e de gestão de usuários (a API existe).
- Visual do protótipo aplicado ao código.
- Aviso de reserva perto de expirar, agenda, fotos e O.S., tela do cliente, chamados para a SpeedWiki, financeiro, dashboards, segundo fator.

## 7. Identidade visual

O dono do projeto quer o portal com **cara de produto feito com intenção**, "sem cara de vibe code", com identidade própria e animações que não sejam o fade genérico.

- **Quem usa:** donos de provedor (parceiros) e técnicos de campo.
- **Sensação:** rapidez e confiança, com um toque de tecnologia atual. Referências: Apple, Cloudflare, Supabase.
- **O dono da Speed adora gráficos que "enchem os olhos"**: o painel precisa ser rico em gráficos.
- **Histórico:** três direções (Fibra, Editorial, NOC) foram rejeitadas. Da segunda rodada, ele amou a barra de busca do modelo "busca primeiro", a sidebar do modelo estilo Linear e gostou por completo do painel claro estilo Vercel/Stripe, mas achou "frágil".
- **Modelo 4 (aprovado):** síntese das três: base clara reforçada, sidebar com grupos e contadores, busca com Ctrl K, tema claro e escuro. Fonte **Geist** (Geist Mono para números técnicos) no desktop; no celular, fonte do sistema (SF Pro / Roboto) para parecer app nativo.
- **Telas no protótipo** (só visual, sem função): painel com gráfico de área com crosshair, donut de saúde da base, mapa de calor de ocupação de CTO, barras por atendente e feed ao vivo; nova venda com mapa e portas; reservas com anéis de contagem regressiva; mapa da rede com "simular falha"; clientes com semáforo e sinal de 30 dias; chamados com rastreio estilo entrega; financeiro com receita acumulada vs meta; resumo do mês em formato stories; avisos com toasts e sino; celular do técnico com abas, medidor de sinal, trava de sinal, fotos e assinatura.
- **Tokens principais** (tema claro): fundo `#f6f7f9`, superfície `#ffffff`, tinta `#0b0d12`, dado `#2563eb`, marca `#ff5a1f`, status `--c-ok #14864a`, `--c-warn #c98a00`, `--c-bad #cf2f2f`. O tema escuro tem valores próprios no protótipo.
- **Evitar:** cards todos iguais com emoji no menu, gradiente roxo, KPI com ícone em cima, fade em tudo.

## 8. SpeedWiki e como os dois vão conversar

O que se sabe da SpeedWiki (lido do repositório em 6 out 2026; o `CLAUDE.md` dela é a fonte detalhada):

- Portal interno de operações da Speed, produção em `speedwiki.speednettelecom.com.br` (VM 179.106.108.48).
- React 18 + Vite + TS, Supabase self-hosted (Postgres 15, RLS por role), proxy Node + Hono (`deploy/proxy/server.js`), Caddy, deploy por GitHub Actions no push em `main`.
- **Já integrado e reaproveitável:** Codemaps (viabilidade por endereço via `equipment/nearbyaddress`, diagrama de splitters), OLTCloud (API REST v2: ONUs, `box/list` com ocupação porta a porta, `box/attenuations` com média de sinal por CTO, reboot via ACS), Voalle (API thirdparty com token cacheado + Postgres read-only), Zabbix, Evolution (WhatsApp), Kanban externo.
- **Não existe ainda na Wiki:** autorização/liberação de ONU no OLTCloud, criação de contrato e ponto de acesso no Voalle, endpoint externo para abrir incidente/chamado (incidentes de infra ficam na tabela `incidents`).
- **Modelo de integração a seguir:** o SpeedParceiros (repo próprio, servidor 179.106.108.58) consome rotas `/proxy/parceiros/*` da Wiki com header de API key.

**O que o Rede Neutra vai precisar da SpeedWiki** (proposta, ainda não implementada em nenhum dos lados):

1. **Abrir chamado de infraestrutura** marcado como rede neutra, com parceiro, contrato, CTO, motivo, sinal medido e fotos. Motivos: CTO com problema, porta off, conferência de porta após divergência, sinal fora do padrão na CTO, rompimento/queda regional. Inclui os chamados automáticos da trava de sinal.
2. **Consultar status e histórico** desse chamado, para o parceiro acompanhar pelo portal (ele nunca vê a Wiki).
3. **SLA configurável por tipo de chamado** (prazos ainda a definir pela diretoria).
4. Possivelmente, **passar pelo servidor da Wiki** para alcançar Codemaps, OLTCloud e Voalle, já que esses sistemas liberam acesso por IP. Alternativa: liberar o IP do servidor do Rede Neutra nesses sistemas. Ainda não decidido.

Formato sugerido: rotas `/proxy/redeneutra/*` no proxy Hono da Wiki, protegidas por uma chave dedicada (por exemplo header `X-RedeNeutra-Key`), espelhando o que já existe para o SpeedParceiros. Do lado do portal, a integração entra atrás de uma interface nova em `apps/api/src/integrations/types.ts`, com um mock para testes.

**Primeiro passo prático com a Wiki em mãos:** rodar, no servidor da SpeedWiki e com as credenciais dela, o script só de leitura:

```bash
INTEGRATIONS_MODE=real npm run validate:integrations -w apps/api -- "Rua X, 100, Cidade"
```

Ele confere login e leitura nos três sistemas, cruza a CTO do Codemaps com a ocupação do OLTCloud e procura no schema da API do OLTCloud rotas de autorização de ONU. A resposta decide como fica a liberação de ONU.

## 9. Regras que não podem ser quebradas

- **Nunca escrever em Voalle, OLTCloud ou Codemaps sem validação explícita do Juan.** São produção.
- Toda rota de dado do parceiro filtra por `partner_id` da sessão no servidor; recurso de outro parceiro responde 404.
- Toda ação que mexe na rede ou no cadastro grava em `audit_log`.
- Credenciais dos sistemas de origem só no servidor, nunca no navegador.
- Senha PPPoE visível só para quem precisa, com registro de quem consultou.

## 10. Decisões em aberto

**Da diretoria:** SLA dos chamados por tipo; o que fazer quando a porta reservada não funciona em campo (o PDF recomenda registrar na O.S. com validação e alerta à Logística); fotos obrigatórias ou opcionais; tabela de preços fixa ou degressiva; limite por CTO (sugerido 50%); módulo de WhatsApp no piloto; indicadores do painel da Speed.

**Técnicas:** como agrupar os contratos do parceiro no Voalle para faturamento consolidado; limite prático de contratos sob o mesmo CNPJ; regra que define o concentrador correto por OLT e região; se a API do OLTCloud permite autorizar ONU; por onde o portal acessa os sistemas liberados por IP.

## 11. Próximos passos sugeridos

1. Rodar o `validate:integrations` no servidor da SpeedWiki (só leitura) e registrar o resultado.
2. Desenhar com a Wiki as rotas `/proxy/redeneutra/*` para chamados.
3. Levar o visual do modelo 4 para `apps/web`, começando por viabilidade e reservas, que já têm API.
4. Em paralelo, investigar só lendo como criar contrato com ponto de acesso no Voalle e autorizar ONU no OLTCloud.
