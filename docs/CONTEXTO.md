# Speed Rede Neutra — contexto completo

Documento para quem chega agora ao projeto, em especial um Claude que está trabalhando no repositório da **SpeedWiki** (`juanbalaquente/SpeedWiki`) e precisa entender o Rede Neutra para integrar os dois. Escrito em 6 out 2026; §5 e §6 revistos em 2026-11-23 (o diário do estado do código foi para `docs/modulos/`, índice no §6). As seções 1 a 4 e 7 a 11 guardam o que foi decidido na data de cada item.

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

- **Chave única = número do contrato Voalle**, padrão `CONTRATO-PRIMEIRONOME`, em que o nome é o do **provedor parceiro** (decisão do Juan, 9 out 2026: o login PPPoE é o próprio código do contrato; parceiro do piloto **JHV**, ex.: `12345-JHV`). Nenhum nome de assinante entra no identificador. O mesmo código identifica a porta na CTO, o registro no Codemaps, o cadastro no OLTCloud e o usuário PPPoE. Toda busca parte dele.
- **Contratos no nome do parceiro.** Juridicamente o cliente da Speed é o parceiro. O portal tem um campo livre de *apelido* para o nome do assinante final, que nunca vai para o Voalle.
- **Perfis:**
  - *Atendente* (do parceiro): viabilidade, reserva, contrato, agenda, liberação de ONU, chamado, bloqueio/desbloqueio.
  - *Supervisor* (do parceiro): tudo do atendente + dashboards, financeiro, preços de venda, gestão dos próprios usuários. Deve ter segundo fator.
  - *Administrador Speed*: cadastra parceiros, define limites e preços, vê auditoria, bloqueia um parceiro inteiro.
- **Fluxo de um cliente (etapas do PDF):**
  1. Viabilidade no Codemaps (CTOs próximas, portas livres de verdade, planos). Toda consulta é registrada, mesmo sem viabilidade (mostra demanda reprimida).
  2. Reserva de **vaga** na CTO por **48 h** (decisão de 7 out 2026: o número da porta não importa; qualquer saída de splitter pode ir para cliente), só no banco do portal (o Codemaps não tem reserva). Expira sozinha, pode ser cancelada, tem limite de reservas simultâneas.
  3. Contrato no Voalle por automação: cria no nome do parceiro, vincula CTO/porta, gera PPPoE, **preenche o ponto de acesso (concentrador)** e devolve o número do contrato. O parceiro dá o aceite no portal, a automação aprova no Voalle e o portal mostra PPPoE e senha.
  4. Agenda de visita (calendário) e envio do roteiro ao técnico por WhatsApp (módulo opcional, instância separada do parceiro, não usa o Omni da Speed).
  5. Liberação da ONU pelo OLTCloud: técnico busca a SN entre as não autorizadas, o portal valida o sinal, autoriza, mostra a VLAN e confirma que a ONU subiu e o PPPoE autenticou. **Trava de sinal:** se o sinal medido diferir mais de **1,5** da média da CTO, só prossegue com justificativa, que abre chamado automático para a Infra. **Atualização (Juan, 9 out 2026):** a referência da trava é o sinal que o técnico **mede na CTO ao chegar, com foto obrigatória**, e não a média do OLTCloud. O sinal na ONU pode ser no máximo **1,5 dB pior** que o da CTO. O limite é um parâmetro editável pela Speed (pode mudar).
  6. Fotos (CTO aberta, etiqueta da porta, medição, sobra de fibra, ONU instalada) com data, hora, GPS e contrato, e fechamento da O.S.
- **Tela do cliente (semáforo de 3 estados):** Fibra (OLTCloud), Autenticação PPPoE (Voalle/RADIUS) e Situação do contrato (Voalle). Fibra verde com PPPoE vermelho é cadastro; fibra vermelha é problema físico.
- **Automações sobre o cliente:** bloqueio por inadimplência (bloqueio administrativo no Voalle é o preferido), desbloqueio, reinício de ONU, cancelamento (encerra contrato, remove ONU, devolve porta).
- **Proteção da rede:** limite de ocupação por CTO por parceiro (sugerido **50%**), limite de reservas simultâneas, auditoria de tudo que mexe na rede ou no cadastro.
- **Valor da Speed por porta ativada (diretoria, 28 out 2026):** 600 Mega R$ 40, 800 Mega R$ 50, 1 Giga R$ 70, iguais para todos os parceiros. Tabela fixa, sem degrau. Vale também para os meses já fechados (o fechamento usa o valor atual do plano). O 700 Mega saiu da venda; quem tiver continua cobrado a R$ 44. Aplicado pela migration 0019, com auditoria (`plano.preco_speed`, `plano.fora_da_venda`). O preço de venda ao cliente final é de cada parceiro; como referência, o Financeiro do parceiro mostra quanto a própria Speed cobra do cliente final (600 Mega R$ 99,90, 800 Mega R$ 129,90, 1 Giga R$ 149,90; coluna `plans.reference_price_cents`, migration 0020, sem tela de edição ainda).

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

Repositório `juanbalaquente/rede-neutra-speed` (privado). Desde 2026-10-06 o trabalho está no branch `claude/project-thread-tj04vv`, à frente do `main`; qual branch o servidor roda está no [`ONDE_PAREI.md`](../ONDE_PAREI.md).

- Monorepo npm workspaces, TypeScript.
- `apps/api`: Node + **Hono**, Postgres + **Drizzle**, sessão em cookie httpOnly (jose), senhas com bcrypt, validação com zod. Imports relativos com extensão `.js` (build NodeNext).
- `apps/web`: React 19 + Vite, com o visual do modelo 4 (seção 7). (Em 6 out 2026 eram três telas simples, sem o visual aprovado.)
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

Rotas da API em 6 out 2026 (a lista completa de hoje está em `apps/api/src/app.ts`): `/health`, `/auth/login|logout|me`, `POST /viability`, `GET|POST /reservations`, `POST /reservations/:id/cancel`, `GET /plans`, `GET|POST /users`, `POST /users/:id/active`, e sob `/admin`: `GET|POST /partners`, `PATCH /partners/:id`, `GET /audit`.

Variáveis de integração (`.env.example`): `INTEGRATIONS_MODE` (`mock` ou `real`), `CODEMAPS_TOKEN`, `CODEMAPS_SECRET`, `OLTCLOUD_BASE`, `OLTCLOUD_USER`, `OLTCLOUD_PASS`, `VOALLE_ERP_URL`, `VOALLE_CLIENT_ID`, `VOALLE_CLIENT_SECRET`, `VOALLE_SYNDATA`. São as mesmas credenciais que a SpeedWiki já usa. Depois vieram `INTEGRATIONS_MODE=wiki` (`WIKI_BASE_URL`, `WIKI_API_KEY`, `WIKI_WRITE_KEY`) e os interruptores `ACTIVATION_MODE`, `AUTOMATION_MODE`, `CLIENT_STATUS_MODE` e `CONTRACT_MODE` (ver §6).

## 6. Estado do código

Reescrito em 2026-11-23 (card T-013). O diário que ficava aqui foi movido sem cortes para `docs/modulos/`, um arquivo por assunto; **antes de mexer num módulo, leia o arquivo dele**. Ponto de retomada, o que está no ar e o que falta validar: [`ONDE_PAREI.md`](../ONDE_PAREI.md) na raiz.

- O portal cobre o fluxo inteiro do planejamento: viabilidade, reserva, contrato no Voalle e ativação da ONU pela Wiki, agenda, fotos e O.S., tela do cliente, ações do cliente (bloquear, desbloquear, reiniciar, cancelar, trocar Wi-Fi, abrir a página do roteador), chamados, painéis, financeiro e administração Speed.
- Piloto em produção com o parceiro JHV desde 2026-10-21 (primeiro contrato e ativação de ponta a ponta, em [`contrato-e-ativacao.md`](modulos/contrato-e-ativacao.md)).
- Último número de testes registrado: 347 (2026-10-29). Os testes cobrem só a API; não há teste de interface em `apps/web`.

| Arquivo | Cobre |
|---|---|
| [`modulos/venda-e-reserva.md`](modulos/venda-e-reserva.md) | Modelo de vagas, área por sigla, reserva de 48 h, pedido de vaga em CTO cheia, gestão de parceiros; estado do código de 6 e 7 out 2026 (histórico) |
| [`modulos/instalacao-e-campo.md`](modulos/instalacao-e-campo.md) | Plano, visita (dia + período) e técnico na reserva, endereço pelo CEP, Instalações e fechamento da O.S., Agenda, fotos de campo |
| [`modulos/contrato-e-ativacao.md`](modulos/contrato-e-ativacao.md) | Contrato no Voalle pela Wiki (`CONTRACT_MODE`), contrato sem valor, ativação da ONU (`ACTIVATION_MODE`, contrato v2), testes de bancada, primeiros clientes JHV, configuração completa, nova tentativa depois de `falha_provisionamento` (2026-10-29) |
| [`modulos/clientes-e-suporte.md`](modulos/clientes-e-suporte.md) | Tela do cliente (semáforo e sinal), ciclo de vida do cliente, bloqueio pela ONU, tela ONUs, troca de Wi-Fi, "Abrir página do roteador", chamados de infraestrutura |
| [`modulos/paineis-e-admin.md`](modulos/paineis-e-admin.md) | Painel do parceiro, financeiro, painel da Speed e meta de receita (redesenho `5c15627`), "Ver painel do parceiro", limite por CTO, aprovação de operações, ações em lote, relatórios |
| [`modulos/seguranca-e-qualidade.md`](modulos/seguranca-e-qualidade.md) | Segundo fator (TOTP) e a revisão de bugs e usabilidade de 20 out 2026 |

**Interruptores de integração.** O padrão no código (`apps/api/src/config.ts`) e no `.env.example` é `INTEGRATIONS_MODE=mock` e `ACTIVATION_MODE`, `AUTOMATION_MODE`, `CLIENT_STATUS_MODE` e `CONTRACT_MODE` em `off`. O valor de produção existe só no `.env` do servidor: os diários registram produção com todos os modos em `wiki` em 2026-10-21 e `AUTOMATION_MODE=wiki` no teste de bloqueio de 2026-10-22. **Valor atual: conferir no servidor** (`printenv` no container `api`).

**Ainda não feito** (conferido no código em 2026-11-23; a lista antiga, de 6 out 2026, está em [`venda-e-reserva.md`](modulos/venda-e-reserva.md)):

- Mapa colorido por ocupação, ocupação por região no painel da Speed e listas com painel lateral (deixados para depois no redesenho de 26 out 2026).
- O modelo da ONU ainda é digitado no fechamento da O.S. (`apps/web/src/pages/InstallationsPage.tsx`; o portal não guarda o modelo da lista de pendentes).
- Preço de referência ao cliente final (`plans.reference_price_cents`) sem tela de edição: só aparece no Financeiro.
- Alarme do cliente pelo estado atual do snapshot, não pela transição entre leituras.
- Módulo de WhatsApp (fase 3) e app do técnico: não existem no código.
- Testes de interface (só a API é testada).
- Fora do escopo do piloto: página de aviso ao assinante bloqueado (exigiria portal cativo no NE40).

## 7. Identidade visual

O dono do projeto quer o portal com **cara de produto feito com intenção**, "sem cara de vibe code", com identidade própria e animações que não sejam o fade genérico.

- **Quem usa:** donos de provedor (parceiros) e técnicos de campo.
- **Sensação:** rapidez e confiança, com um toque de tecnologia atual. Referências: Apple, Cloudflare, Supabase.
- **O dono da Speed adora gráficos que "enchem os olhos"**: o painel precisa ser rico em gráficos.
- **Histórico:** três direções (Fibra, Editorial, NOC) foram rejeitadas. Da segunda rodada, ele amou a barra de busca do modelo "busca primeiro", a sidebar do modelo estilo Linear e gostou por completo do painel claro estilo Vercel/Stripe, mas achou "frágil".
- **Modelo 4 (aprovado):** síntese das três: base clara reforçada, sidebar com grupos e contadores, busca com Ctrl K, tema claro e escuro. Fonte **Geist** (Geist Mono para números técnicos) no desktop; no celular, fonte do sistema (SF Pro / Roboto) para parecer app nativo.
- **Telas no protótipo** (só visual, sem função): painel com gráfico de área com crosshair, donut de saúde da base, mapa de calor de ocupação de CTO, barras por atendente e feed ao vivo; nova venda com mapa e portas; reservas com anéis de contagem regressiva; mapa da rede com "simular falha"; clientes com semáforo e sinal de 30 dias; chamados com rastreio estilo entrega; financeiro com receita acumulada vs meta; resumo do mês em formato stories; avisos com toasts e sino; celular do técnico com abas, medidor de sinal, trava de sinal, fotos e assinatura.
- **Tokens principais** (tema claro): fundo `#f6f7f9`, superfície `#ffffff`, tinta `#0b0d12`, dado `#2563eb`, marca `#ff5a1f`, status `--c-ok #14864a`, `--c-warn #c98a00`, `--c-bad #cf2f2f`. O tema escuro tem valores próprios no protótipo.
- **Tema Azul Speed (pedido do dono, 19 out 2026):** terceira opção ao lado de claro e escuro, mais próxima da identidade da Speed: fundo azul-marinho (`#091733`, superfície `#0e2048`), dado `#7fb0ff` e o **laranja da marca (`#ff5a1f`) nos botões principais**. Só por escolha do usuário (o padrão segue o sistema, claro ou escuro), no seletor do cabeçalho ou no Ctrl K; fica salvo no navegador (`rn-theme = blue`).
- **Evitar:** cards todos iguais com emoji no menu, gradiente roxo, KPI com ícone em cima, fade em tudo.

## 8. SpeedWiki e como os dois vão conversar

**Nota de 2026-11-23:** esta seção é o retrato de 6 out 2026. Hoje a integração existe nos dois lados: rotas `/proxy/redeneutra/v1` (leitura), `v2` (ativação) e `v3` (contrato, clientes, chamados, Wi-Fi, acesso web), descritas nos `CONTRATO-WIKI-*.md`; o lado da Wiki fica em `SpeedWiki/docs/modulos/rede-neutra.md`.

O que se sabia da SpeedWiki (lido do repositório em 6 out 2026; o `CLAUDE.md` dela é a fonte detalhada):

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
- Senha PPPoE: **decidido que o portal nunca vê nem exibe** (16 out 2026). A Speed usa a mesma senha padrão para a rede neutra, gravada pela Wiki ao criar o contrato e entregue ao parceiro pelo canal comercial. Não há rota, tela nem ação de trocar senha.

## 10. Decisões em aberto

**Da diretoria:** SLA dos chamados por tipo; o que fazer quando a porta reservada não funciona em campo (o PDF recomenda registrar na O.S. com validação e alerta à Logística); fotos obrigatórias ou opcionais; tabela de preços fixa ou degressiva; limite por CTO (sugerido 50%); módulo de WhatsApp no piloto; indicadores do painel da Speed.

**Técnicas:** como agrupar os contratos do parceiro no Voalle para faturamento consolidado; limite prático de contratos sob o mesmo CNPJ; regra que define o concentrador correto por OLT e região; se a API do OLTCloud permite autorizar ONU; por onde o portal acessa os sistemas liberados por IP.

## 11. Próximos passos sugeridos

**Lista de 6 out 2026, toda feita ou superada** (os quatro itens viraram a integração pela Wiki v1/v2/v3 e o visual do modelo 4). Próximos passos de hoje: [`ONDE_PAREI.md`](../ONDE_PAREI.md).

1. Rodar o `validate:integrations` no servidor da SpeedWiki (só leitura) e registrar o resultado.
2. Desenhar com a Wiki as rotas `/proxy/redeneutra/*` para chamados.
3. Levar o visual do modelo 4 para `apps/web`, começando por viabilidade e reservas, que já têm API.
4. Em paralelo, investigar só lendo como criar contrato com ponto de acesso no Voalle e autorizar ONU no OLTCloud.
