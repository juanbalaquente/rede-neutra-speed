# Conformidade com o planejamento original

Comparação do que o portal faz hoje com o [`planejamento.pdf`](planejamento.pdf) (@Guilherme, 5 out 2026). Conferida em 15 out 2026 contra o código, os testes e o portal rodando, e **revalidada em 16 out 2026 relendo o PDF inteiro** (chamados, tela do cliente, automações, contrato pela Wiki, mapa por sigla e as decisões novas da Speed) e **fechada em 16 out 2026**: tudo o que o PDF pede e que o portal podia fazer sozinho está feito (a maior parte contra mock); o que sobra é **Externo** (Wiki, Voalle), **decisão** (Juan, diretoria) ou **opcional** (WhatsApp). Ver o resumo no fim.

Legenda: **Feito** = funciona e está testado · **Parcial** = existe, mas falta parte do que o planejamento pede · **Falta** = não existe · **Desvio decidido** = o código faz diferente do PDF por decisão registrada · **Externo** = depende de Voalle, Codemaps ou SpeedWiki.

## Desvios decididos (o código não segue o PDF de propósito)

| Tema | PDF | Portal | Decisão |
|---|---|---|---|
| Reserva | escolhe CTO **e porta** | reserva de **vaga** na CTO; o número da porta não importa | Juan, 7 out 2026 |
| Referência da trava de sinal | média da CTO (OLTCloud) | sinal **medido pelo técnico na CTO, com foto**; limite de 1,5 dB editável pela Speed | Juan, 9 out 2026 |
| Porta na ativação | técnico confirma a porta usada e há fluxo de divergência de porta | o técnico **não informa porta** e a Wiki não vincula porta | resposta da Wiki, 14 out 2026 |
| Segundo fator | só supervisor | supervisor **e administrador Speed** (atendente opcional) | 15 out 2026 |
| Identidade visual | laranja e azul-marinho da Speed | identidade própria, protótipo `modelo-4` | CONTEXTO, 6 out 2026 |
| Perfil de login PPPoE | `CONTRATO-PRIMEIRONOME` | `CONTRATO-CÓDIGO` do **provedor** (ex.: `12345-JHV`) | Juan, 9 out 2026 |
| Senha PPPoE | portal libera usuário e senha no aceite, mostra na tela do cliente e no card da visita, com registro de quem consultou; há "troca de senha" | o portal **nunca vê nem exibe senha**; a Wiki grava a senha padrão da Speed ao criar o contrato e o parceiro a recebe pelo canal comercial; **sem troca de senha** | Speed, 16 out 2026 |
| Cobrança | contrato no Voalle no nome do parceiro, faturado pelo ERP (fatura consolidada por CNPJ) | **contrato sem valor**: só identifica o cliente e gera o PPPoE. O parceiro paga direto ao dono da Speed, fora do ERP, pelo **fechamento do portal** | Juan, 18 out 2026 |
| Aceite do contrato | o contratante revisa e aceita no portal; no aceite a automação aprova o contrato | não há tela de aceite: a criação é automática; aprovar só importa se o Voalle exigir para a conexão autenticar (sem efeito na cobrança) | proposta da Wiki, 16 out 2026; ajustada em 18 out |
| Criação do contrato | número digitado pelo parceiro vindo do Voalle | com `CONTRACT_MODE` ligado, o contrato nasce da Wiki (Voalle) e o login vem dele | proposta da Wiki, 16 out 2026 |

## Etapa a etapa

| Etapa / tema | Estado | Detalhe |
|---|---|---|
| **1. Viabilidade** | Feito (em `mock`; **Externo** para dado real) | CTOs próximas, distância, vagas livres, planos. Reserva de outro parceiro some para todos. Toda consulta é registrada, mesmo sem viabilidade. A CTO aparece no mapa de pontos e com **link de rota** (também nas instalações). |
| **2. Reserva de 48 h** | Feito | Trava real sob lock, expira sozinha, cancela com motivo (Speed), limite simultâneo, aviso antes de vencer (menu, toast e faixa). A Speed vê tudo no painel. **Desvio:** não expira durante uma ativação em andamento. |
| **3. Contrato no Voalle** | Parcial (**Externo** para o Voalle) | **Feito no portal (contra mock):** plano, apelido (nunca vai para o Voalle), data da visita e técnico; **criação automática do contrato** com endereço estruturado, etapas visíveis, idempotência, login vindo do contrato, e **reserva sem prazo e sem cancelamento depois do contrato pedido** (como o PDF manda). A Wiki já tem a automação pronta (ponto de acesso pela sigla da CTO: R1 = 2, ITA = 3, FAT = 11). **Endurecido em 18 out:** contrato que para no meio (`parcial`) repete com a mesma chave, o que falha depois de criar algo **não aceita novo pedido** (evita segundo contrato), a Speed vê os contratos parados no painel e no sino e pode **abandonar** um contrato (cancela a reserva, devolve a vaga e registra o número para cancelar no Voalle), e o endereço da consulta vem sugerido no formulário. Fluxo completo e roteiro do primeiro cliente real em [`FLUXO-CONTRATO-E-CONEXAO.md`](FLUXO-CONTRATO-E-CONEXAO.md). **Falta (Externo):** a rota da Wiki, a configuração no Voalle e o **cancelamento do contrato não aprovado**; **decisão do Juan:** gatilho de aprovação e primeiro mês proporcional. Sem a rota, o número segue digitado. |
| **4. Calendário e WhatsApp** | Parcial | **Feito:** agenda em dia, semana e mês, cards com contrato, apelido, CTO, plano e técnico, filtro por técnico, arrastar para reagendar (vira "reagendada", auditado), visita "em execução" ao liberar a ONU, "concluída" ao fechar a O.S. e aviso de visita atrasada. **Falta:** disparo diário por WhatsApp (módulo opcional) e o reenvio manual. |
| **5. Liberação da ONU** | Parcial (**Externo** para a execução real) | Lista pendentes, confere a serial pela etiqueta, trava de sinal, justificativa, decisão em 30 min, estados até `online`, **mostra a VLAN e o login a configurar** (a VLAN vem da Wiki quando ela informar) e **abre o chamado automático à Infra** na justificativa. **A Wiki construiu a v2 (16 out 2026), desligada:** o portal já manda `X-RedeNeutra-Partner` em todas as chamadas, trata os 503 de rota desligada (`chave_de_escrita_nao_configurada`, `ativacao_desligada`, `leitura_de_sinal_pendente`) como aviso e guarda o pedido, e mostra as recusas `serial_em_ativacao` e `login_fora_do_padrao`. **A Wiki testou a v2 ponta a ponta numa ONU da Speed em 16 out** (autorizar, medir o sinal logo após autorizar, provisionar, online com PPPoE; cerca de 70 s) e as rotas de leitura estão ativas; sem leitura de sinal em 2 min a decisão vem com `sem_leitura_de_sinal` e o portal oferece medir de novo, prosseguir ou cancelar. **Falta:** a Wiki ligar `POST /ativacoes` e `/decisao` com o primeiro cliente real (depende do contrato no Voalle com login `<contrato>-JHV`) e a sua validação para `ACTIVATION_MODE=wiki`. |
| **6. Fotos e O.S.** | Feito | Seis tipos (o checklist do PDF mais a medição na CTO), data/hora/GPS/contrato, redução no celular, **tela Instalações** para o parceiro e a Speed (galeria, mapa, link assinado de 48 h para a Infra) e **fechamento da O.S.** (sinal final, modelo e serial da ONU, porta opcional, observação) exigindo as fotos; a Speed pode tornar as fotos opcionais (decisão da diretoria em aberto). |
| **Tela do cliente** | Parcial | Semáforo de fibra, PPPoE e contrato com idade do dado, ONU, sinal de 7/30/90 dias com mínimo aceitável e quedas, consulta ao vivo, ações (bloquear, reiniciar, cancelar) e alarmes de estado atual no painel e no sino. Roda contra mock. As rotas de leitura da Wiki já estão no ar (fibra, contrato e sinal; o PPPoE aguarda o snapshot do NE40). Abrir chamado direto da tela do cliente e links de rota até a CTO e o cliente já existem. **Falta:** alarme por transição e ligar `CLIENT_STATUS_MODE=wiki` com uma ONU real. |
| **Chamados de infra** | Parcial | Abertura, lista, histórico, resposta, reenvio, prazo (SLA por tipo editável pela Speed, sem código), atraso no sino e no painel, e chamado automático da trava de sinal. Roda contra mock. Fotos do cliente podem ser anexadas no formulário (até 6). **Falta (Externo):** as rotas da Wiki (v3, seção D), a escolha do board do Kanban e os valores de SLA da diretoria. |
| **Automações do cliente** | Parcial (**Externo** para a execução real) | **Feito no portal:** bloquear, desbloquear, reiniciar a ONU e cancelar (só supervisor), com confirmação, motivo, etapas visíveis, repetição de operação parcial e **vaga devolvida** ao cancelar; contra mock, com o cliente real da Wiki já escrito conforme o contrato v3. **Falta (Externo):** as rotas v3 da Wiki e o cancelamento de contrato no Voalle. **Decisões do Juan:** bloqueio por suspensão (para a cobrança) ou manual (mantém a cobrança, como o PDF exige) e a regra de fatura em aberto (o parceiro, não o assinante, é quem deve). **Execução em lote** feita (bloquear, desbloquear e reiniciar até 50; cancelamento fica cliente a cliente). A Speed pode exigir **aprovação** por tipo (desligada por padrão). Troca de senha PPPoE foi **retirada** por decisão da Speed. |
| **Bloqueio do parceiro inteiro** | Parcial | Bloqueia o acesso ao portal com motivo obrigatório e confirmação dupla na tela. **Falta:** o bloqueio em massa dos **clientes** dele no Voalle. |
| **Planos e financeiro** | Feito (primeira entrega do PDF) | Preço de venda por plano (supervisor), valor fixo da Speed por porta ativada (admin), custo, faturamento previsto, lucro e margem por plano, **marcação manual de pago/não pago** por cliente e mês, recebido e em aberto, exportação em planilha (fechamento e base de clientes) com filtros por plano, CTO e situação, e **PDF pela impressão do navegador**. **Desde 18 out o fechamento do portal é a base da cobrança** (o contrato no Voalle não tem valor): a Speed tem a "Cobrança dos parceiros" por mês com demonstrativo por parceiro, e o cliente cancelado é cobrado no mês do cancelamento sem alterar meses passados. **Falta:** as formas 2 e 3 de alimentar o pagamento (arquivo de retorno, integração), que o próprio PDF sugere deixar para depois do piloto. |
| **Dashboards do supervisor** | Parcial | Painel do parceiro: portas ativas, instalações no mês, O.S. pendentes, reservas, visitas hoje e atrasadas, gráficos dos últimos 6 meses, portas por plano. Fibra online vs PPPoE conectado, bloqueados, offline e chamados com SLA já aparecem (contra mock; reais dependem da Wiki v3). Qualidade média de sinal da base e clientes com mais quedas (supervisor), filtros por plano, CTO e situação nas telas e nas planilhas, e PDF pela impressão do navegador. **Falta:** rota em lote da Wiki para o sinal da base (hoje uma chamada por cliente, guardada por 10 min). |
| **Painel da Speed** | Parcial | Consultas por dia (com, sem e fora da área), CTOs vistas por sigla, relatório de CTOs "conferir", auditoria com filtros. A rede inteira por sigla (R1, ITA, FAT) com estado de cada CTO e a lista de chamados de todos os parceiros já existem. Portas e receita por parceiro, chamados abertos, instalações fora do padrão de sinal, CTOs com muitos chamados e a aprovação ou recusa de operações já existem. Os indicadores exatos ainda são decisão da diretoria. |
| **Proteção e auditoria** | Feito | Limite de ocupação por parceiro (50% sugerido) **e por CTO** (por parceiro ou para todos), **liberação caso a caso** pela Speed, limite de reservas, bloqueio de liberação sem justificativa, **alerta de muitos chamados do mesmo parceiro na mesma CTO**, e auditoria de viabilidade, reserva, contrato, ONU, bloqueio, reinício, cancelamento, chamados, preços, usuários, 2FA, fotos e aprovações. |
| **Uso em campo** | Feito | Responsivo e testado no celular, foto com compressão, e o que foi digitado nos formulários (dados do cliente, liberação da ONU, fechamento da O.S.) **sobrevive ao recarregar a página**; um erro de tela mostra uma mensagem com botão de recarregar em vez de tela branca. |
| **Segurança** | Feito (**atenção:** o servidor de teste está com `MFA_REQUIRED=false`; religar antes do piloto) | Senha forte, 2FA (TOTP), permissões no servidor, credenciais só no servidor, sessão de 8 h, isolamento por parceiro com 404. A senha PPPoE **não será exibida nem trocada pelo portal** (decisão da Speed, 16 out 2026: senha padrão gravada pela Wiki e entregue pelo canal comercial). |
| **Disponibilidade** | Parcial | Fonte fora do ar vira aviso claro (sem expor o sistema), faixa vermelha para a Speed, log de todas as chamadas, idempotência na ativação e `/api/health` com o estado da rede (`rede`), cacheado, para o Zabbix. **Falta:** ligar de fato o monitoramento no Zabbix/Grafana. |

## Telas do protótipo aprovado (`modelo-4.html`) ainda sem versão real

| Protótipo | Estado |
|---|---|
| Nova venda | Feito |
| Reservas | Feito |
| Painel do parceiro ("Bom dia…") | Feito (fibra e PPPoE contra mock; reais dependem da Wiki) |
| Campo (técnico no celular) | Feito (painel Liberar ONU, fotos, O.S.) |
| Clientes | Feito como **Instalações** (lista com filtros, lote e galeria) e a **tela do cliente** (semáforo e sinal); a versão "cartões com semáforo de todos" do protótipo não existe |
| Chamados | Feito no portal (mock) |
| Financeiro | Feito |
| Mapa da rede | Parcial: painel da Speed com a rede inteira por sigla (pontos coloridos por estado), sem mapa de fundo; o mapa do parceiro e o "simular falha" do protótipo não existem |
| Resumo do mês | **Falta** |
| Avisos (sino e toasts) | Feito |

## Fases do PDF

| Fase | Itens | Pronto |
|---|---|---|
| **1. MVP** | login e perfis, viabilidade, reserva, contrato no Voalle, liberação da ONU, tela do cliente, painel admin | 7 de 7 no portal; **contrato no Voalle**, liberação da ONU e tela do cliente rodam contra mock e esperam as rotas da Wiki (**Externo**) |
| **2. Operação** | calendário, fotos e O.S., histórico de sinal, bloqueio/desbloqueio/reinício, chamados, preços e dashboard | 6 de 6 no portal; **histórico de sinal, bloqueio/desbloqueio/reinício e chamados** rodam contra mock e esperam as rotas da Wiki (**Externo**) |
| **3. Gestão** | financeiro, relatórios, WhatsApp, limites por CTO, auditoria consultável | financeiro, relatórios (planilha e PDF por impressão, com filtros), limite por CTO e auditoria consultável feitos; falta o **WhatsApp** (módulo opcional) e a validação com o segundo contratante |

## Decisões da diretoria que continuam em aberto
SLA dos chamados · divergência de porta (hoje superada pela decisão da Wiki de não vincular porta) · fotos obrigatórias para fechar a O.S. · tabela fixa ou degressiva · limite de ocupação padrão (50% sugerido; já configurável por parceiro e por CTO) · módulo de WhatsApp no piloto · indicadores do painel da Speed.

## Fechamento (16 out 2026)

**Do PDF, o portal cobre tudo o que dependia só dele.** O que resta, por dono:

- **Wiki (Externo):** ligar a ativação de ONU (v2, construída e desligada), criação de contrato, chamados, reinício, bloqueio, cancelamento, PPPoE no snapshot do NE40 e incidente por CTO. Pedido completo em [`PEDIDO-WIKI.md`](PEDIDO-WIKI.md).
- **Voalle (Externo):** configurar o tipo de contrato com "Integração" e a campanha "E-commerce - Integração"; responder sobre o cancelamento de contrato por API.
- **Decisões do Juan:** regra de cobrança no fechamento do portal (mês cheio ou proporcional na ativação e no cancelamento); board e colunas do Kanban dos chamados. (Gatilho de aprovação, bloqueio por suspensão e fatura em aberto deixaram de ser decisões com o contrato sem valor.)
- **Diretoria:** SLA por tipo de chamado, preço fixo ou degressivo, fotos obrigatórias, WhatsApp no piloto, indicadores do painel da Speed.
- **Opcional / depois do piloto:** módulo de WhatsApp (visitas e alarmes, instância separada, cobrado à parte), pagamento por arquivo de retorno ou integração, tela "Resumo do mês" e mapa do parceiro do protótipo, bloqueio em massa dos clientes de um parceiro inadimplente (depende do Voalle), alarme por transição (precisa do snapshot real), monitoramento no Zabbix/Grafana.
- **Antes do piloto:** religar `MFA_REQUIRED=true`, trocar ou desativar a conta de teste, cadastrar o parceiro real e fazer o backup fora da VM (ver o roteiro de go-live em [`DEPLOY.md`](DEPLOY.md)).
