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

**Liberação de ONU (9 out 2026, teste da Wiki em produção, autorizado pelo Juan, numa ONU da própria Speed):** funciona por automação a partir da Wiki. Desautorizar e autorizar pela rota do **painel** do OLTCloud (sessão web, a mesma que a Wiki usa para criar usuário; campos `onu` = onu_hash da lista de pendentes, `id_olt_id`, `id_cliente_id`, `alias`, `xgspon`, `id_cto_porta_id` opcional), depois provisionar pela API (`POST /api/v2/ftth/equipment/{id}/{script}/script` com `alias` e `ppp_login`, script "AUTENTICADOR (OLT_X)"). ONU voltou Online em ~50 s com o mesmo PPPoE e VLANs. A rota de autorização da **API** existe, mas recusou o corpo (não documentado). Para o portal: identificar a ONU sempre pela **serial** (o id muda a cada reautorização); o IP de gerência muda a cada provisionamento; a saída do script traz a senha PPPoE em texto puro e **nunca** é exibida nem guardada (só sucesso/falha). A escrita continua passando pela Wiki (contrato v2, escrita), com validação do Juan antes de ligar.

**Ciclo de vida do cliente (16 out 2026):** bloquear, desbloquear, reiniciar a ONU e **cancelar** (supervisor; encerra o contrato, remove a ONU e **devolve a vaga**), em operações assíncronas e idempotentes (`customer_operations`, migration 0008) executadas pela Wiki conforme o [contrato v3](CONTRATO-WIKI-V3-CLIENTES.md), atrás de `AUTOMATION_MODE=off|mock|wiki` (desligado por padrão). Operação parcial (falha numa etapa) fica visível e repetir com a mesma chave continua de onde parou; a vaga só volta quando a operação conclui. Bloqueio mantém porta e cobrança. Cliente cancelado continua na lista de Instalações como histórico.

**Criação de contrato pela Wiki (16 out 2026), contra mock:** a Wiki propôs `POST /v3/contratos` (contrato v3, seção H), que cria o contrato no nome do parceiro no Voalle, ajusta a conexão PPPoE para `<contrato>-<CÓDIGO>` e grava o endereço da instalação. No portal, a etapa "Contrato do cliente" da liberação da ONU pede o **endereço estruturado** (CEP, rua, número, complemento, bairro, cidade, UF), cria o pedido (`contract_requests`, migration 0010, um por reserva salvo se falhou), acompanha as três etapas e, ao concluir, grava o número e o login. **Com `CONTRACT_MODE` ligado a ativação ignora o número digitado** e usa o login do contrato criado (`contrato_nao_criado` enquanto não concluir); desligado, tudo segue como antes. O valor mensal enviado é o que a Speed cobra do parceiro pelo plano; nenhum nome de assinante vai. Atrás de `CONTRACT_MODE=off|mock|wiki` (padrão off). **Em aberto (Juan):** a aprovação do contrato (e portanto a cobrança) quando a ONU fica online, e a proporcionalidade do primeiro mês. **Falta combinar com a Wiki:** o cancelamento do contrato não aprovado quando a reserva é cancelada antes da ativação (o portal ainda não chama nada nesse caso).

**Wiki v1.1 e v3 de leitura no ar (16 out 2026):** o mapa por sigla (`/v1/regioes/{sigla}/ctos`, 798 CTOs com posição) alimenta o cartão "Rede inteira por sigla" no Painel da rede (admin); as rotas de status e sinal do cliente (`/v3/clientes/...`) estão publicadas, mas o PPPoE ainda vem "não disponível" até a Wiki incluir a rede neutra no poller do NE40. Para ligar a tela do cliente em produção: `CLIENT_STATUS_MODE=wiki` (só leitura, usa `WIKI_API_KEY`); precisa de uma ONU com alias igual ao login para o 404 `login_desconhecido` dar lugar a dado real.

**Tela do cliente (16 out 2026), 181 testes passando:** na Instalação com O.S. fechada, o painel "Situação na rede" mostra o **semáforo de fibra (OLTCloud), PPPoE (NE40) e contrato (Voalle)**, a ONU, desde quando está no ar, a idade de cada leitura (**dado velho** acima de 15 min na fibra e 30 min no PPPoE) e o **sinal da ONU em 7, 30 ou 90 dias** com a linha do mínimo aceitável (medido na CTO menos o limite que valeu na ativação) e as quedas; "Consultar de novo" pede leitura ao vivo. O painel do parceiro ganhou **fibra online e PPPoE conectado lado a lado** (do snapshot, nunca ao vivo, lote de até 200 logins) e a lista de clientes em alarme (sem sinal, offline, sem energia, PPPoE caído; cliente bloqueado sem PPPoE não alarma), que também aparece no sino. Só leitura, atrás de `CLIENT_STATUS_MODE=off|mock|wiki` (padrão off; wiki usa `WIKI_API_KEY`). Cada fonte responde por si e falha vira "sem leitura"/502 sem derrubar a tela. O alarme hoje é o **estado atual** do snapshot, não a transição (o contrato v3 prevê comparar ciclos; fica para quando a Wiki entregar e houver snapshot guardado). Mock: o último dígito do contrato escolhe o cenário (3 = loss, 7 = offline, 9 = bloqueado).

**Chamados de infraestrutura (16 out 2026), 164 testes passando:** o parceiro abre chamado para a Infra (CTO com problema, porta off, conferência de porta, sinal fora do padrão na CTO, rompimento regional), com cliente (herda CTO e login), sinal e descrição, acompanha o histórico e responde pelo portal; a Speed vê todos, só leitura (`tickets` e `ticket_messages`, migration 0009). O chamado **sempre nasce no portal** (estado `recebido`) e depois é entregue à Wiki conforme o [contrato v3, seção D](CONTRATO-WIKI-V3-CLIENTES.md); Wiki fora do ar ou desligada deixa o chamado guardado e "Reenviar" repete com a mesma chave, sem duplicar. Só as mensagens da Infra voltam da Wiki (dedupe por hash); as do parceiro e do sistema já estão no portal. **SLA por tipo** é parâmetro da Speed (Parceiros, "Prazo dos chamados", auditado em `config.sla`); os valores padrão são **provisórios** até a diretoria definir. O prazo vai à Wiki como `slaHoras`; chamado vencido e aberto vira "atrasado" (sino, KPI do painel). **Trava de sinal:** `prosseguir` com justificativa abre sozinho um chamado `trava_sinal` (origem `sistema`, com as duas medições e a foto da medição); falha nele nunca derruba a decisão do técnico. Atrás de `AUTOMATION_MODE=off|mock|wiki`, como as ações do cliente. Fotos no formulário de chamado ainda não têm tela (a API aceita `photoIds`).

**Instalação, agenda e financeiro (15 out 2026, noite), 143 testes passando:** a reserva ganhou plano, apelido, visita, técnico e dados da O.S. (migrations 0006 e 0007). Páginas novas: **Painel** do parceiro, **Instalações** (galeria, link assinado, fechamento da O.S.), **Agenda** (dia/semana/mês, arrastar para reagendar) e **Financeiro** (supervisor: preços de venda, custo, lucro, pagamento manual, planilhas CSV). A ONU só é liberada com plano, visita e técnico; a O.S. só fecha com ONU online e as 6 fotos (interruptor da Speed). Porta ativa = reserva convertida com O.S. fechada. Sino de avisos, faixa de rede fora do ar para a Speed, rascunho dos formulários e proteção contra tela branca. `/api/health` devolve `rede` (cacheado 30 s). Ver `docs/CONFORMIDADE-PLANEJAMENTO.md`.

**Segundo fator (15 out 2026), 112 testes passando:** TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) obrigatório em produção para supervisor e administrador Speed (`MFA_REQUIRED`, `TOTP_KEY`). Login em duas etapas: a senha certa devolve só um desafio de 5 min (sem cookie); o código do aplicativo ou um código de recuperação (10, uso único, só o hash no banco) troca por sessão. Segredo cifrado com AES-256-GCM, replay bloqueado por intervalo, bloqueio após 10 erros. Quem ainda não configurou só alcança `/api/auth/*` (403 `mfa_obrigatorio`). O administrador redefine o 2FA de outro usuário pela tela (auditado); o próprio administrador usa `node dist/scripts/reset-2fa.js <e-mail>` no servidor.

**Fotos de campo (15 out 2026), 96 testes passando:** cinco tipos (medição na CTO, CTO aberta, etiqueta da porta, sobra de fibra, ONU instalada), enviadas pelo celular do técnico com a imagem reduzida (lado maior 1600 px, JPEG) e o GPS do aparelho quando permitido. Metadados na tabela `photos` (contrato, hora do servidor, hora do aparelho, GPS, sha256); o arquivo fica no volume `photos-data` (`PHOTO_DIR`), atrás de uma interface `PhotoStorage` (trocar por S3/MinIO é implementar duas funções), e só sai pela API com checagem de parceiro (404 para foto de outro). O formato é conferido pelos bytes, não pelo tipo declarado. **A foto da medição é obrigatória para pedir a ativação** (`foto_medicao_obrigatoria`). Link assinado para a Infra sem conta: `POST /photos/:id/link`, validade de 1 a 48 h, HMAC com o segredo da sessão, acesso registrado na auditoria. O backup (`deploy/backup-db.sh`) espelha as fotos junto do dump do banco.

**Atualização de 7 out 2026 (sessão do portal), 67 testes passando:**

- **Modelo de vagas (decisões do Juan, 7 out 2026):** reserva por vaga, não por porta. Vaga = saída de splitter livre no diagrama do Codemaps, descontando clientes que o OLTCloud tem a mais; só Codemaps e OLTCloud entram na conta (Voalle e as caixas "nativas" ficam fora). CTO sem caixa no OLTCloud ou com dado velho (mais de 1 h) é "conferir". **Área do piloto por sigla no nome da CTO:** R1 (Backbone Central), ITA (Itacolomi) e FAT (Fátima); o administrador Speed define as siglas liberadas por parceiro (`allowedRegions`, vazio = nada é oferecido).
- **Integração por interface:** `NetworkMap` usa `ctoId` (id do Codemaps) e `getCtoVagas`. Modo `INTEGRATIONS_MODE=wiki` (`integrations/wiki.ts`), só leitura, valida a resposta contra [`CONTRATO-WIKI-V1.md`](CONTRATO-WIKI-V1.md). A Wiki implementou e publicou as três rotas v1 (14 out 2026), mas está **bloqueada pelo Codemaps** (o IP de saída novo, 189.112.67.129, ainda recebe "dns not authorized"; chamado aberto com o suporte). Enquanto isso o portal segue em `INTEGRATIONS_MODE=mock` e `/health` devolve `ok:false`, o que é esperado.
- **Reserva por id:** a trava é `(cto_id, port)` (migration 0001). Reservar exige uma viabilidade do mesmo parceiro, para o mesmo endereço, nas últimas 24 h que tenha listado a CTO.
- **Painel da rede, auditoria e equipe:** o administrador Speed entra no Painel da rede (consultas de parceiros por dia, com viabilidade, sem viabilidade e fora da área; mapa de calor de ocupação das CTOs vistas, por sigla; visão em tabela) e tem Auditoria com nome de quem fez, parceiro e filtros. O supervisor do parceiro gerencia a própria Equipe. O mapa mostra só as CTOs que apareceram em consultas; o mapa completo por sigla depende de uma rota da Wiki (proposta no contrato).
- **Gestão de parceiros (administrador Speed):** tela "Parceiros" com uso atual (reservas abertas, usuários ativos), siglas liberadas (atalho para o piloto R1, ITA, FAT), limites, bloqueio com motivo obrigatório e reativação, e usuários do parceiro (cadastro do primeiro supervisor com senha gerada, desativar e reativar respeitando o limite). Telas conferidas em Chrome headless, claro, escuro e celular.
- **Reserva:** a trava virou contagem sob lock por CTO (reservas vivas de todos os parceiros + 1 ≤ vagas livres), com limite de 50% de `totalVagas` por parceiro, leitura `?fresh=true` e área conferida de novo no servidor. Migration 0002.
- **Front:** o visual do modelo 4 já está em Nova venda e Reservas (casca, Ctrl K, tema, anéis). As demais telas do protótipo ainda não existem. **Não foi verificado em navegador nesta sessão**; só typecheck e build.
- **Cobertura real:** os testes cobrem viabilidade, reserva, isolamento entre parceiros, login, cliente da Wiki e `/partner`. Não cobrem criação de parceiro e de usuário com limite, nem `GET /admin/audit`.
- **Pendências do portal:** trava de sinal (depende da média por CTO vinda da Wiki), limpeza do contador de login em memória, `clientIp` confiando em `x-forwarded-for`, ciclo de vida da reserva `convertida`.

**Pronto e testado até 6 out (18 testes):**

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
- Aviso de reserva, agenda, fotos e O.S., chamados, financeiro, dashboards e segundo fator já existem (rodando contra mock onde dependem da Wiki).

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
- Senha PPPoE: **decidido que o portal nunca vê nem exibe** (16 out 2026). A Speed usa a mesma senha padrão para a rede neutra, gravada pela Wiki ao criar o contrato e entregue ao parceiro pelo canal comercial. Não há rota, tela nem ação de trocar senha.

## 10. Decisões em aberto

**Da diretoria:** SLA dos chamados por tipo; o que fazer quando a porta reservada não funciona em campo (o PDF recomenda registrar na O.S. com validação e alerta à Logística); fotos obrigatórias ou opcionais; tabela de preços fixa ou degressiva; limite por CTO (sugerido 50%); módulo de WhatsApp no piloto; indicadores do painel da Speed.

**Técnicas:** como agrupar os contratos do parceiro no Voalle para faturamento consolidado; limite prático de contratos sob o mesmo CNPJ; regra que define o concentrador correto por OLT e região; se a API do OLTCloud permite autorizar ONU; por onde o portal acessa os sistemas liberados por IP.

## 11. Próximos passos sugeridos

1. Rodar o `validate:integrations` no servidor da SpeedWiki (só leitura) e registrar o resultado.
2. Desenhar com a Wiki as rotas `/proxy/redeneutra/*` para chamados.
3. Levar o visual do modelo 4 para `apps/web`, começando por viabilidade e reservas, que já têm API.
4. Em paralelo, investigar só lendo como criar contrato com ponto de acesso no Voalle e autorizar ONU no OLTCloud.
