# Conformidade com o planejamento original

Comparação do que o portal faz hoje com o [`planejamento.pdf`](planejamento.pdf) (@Guilherme, 5 out 2026), conferida em 15 out 2026 contra o código, os testes e o portal rodando.

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

## Etapa a etapa

| Etapa / tema | Estado | Detalhe |
|---|---|---|
| **1. Viabilidade** | Feito (em `mock`; **Externo** para dado real) | CTOs próximas, distância, vagas livres, planos. Reserva de outro parceiro some para todos. Toda consulta é registrada, mesmo sem viabilidade. **Falta:** a localização da CTO só aparece no mapa de pontos, sem link para rota. |
| **2. Reserva de 48 h** | Feito | Trava real sob lock, expira sozinha, cancela com motivo (Speed), limite simultâneo, aviso antes de vencer (menu, toast e faixa). A Speed vê tudo no painel. **Desvio:** não expira durante uma ativação em andamento. |
| **3. Contrato no Voalle** | **Falta** (Externo) | Sem criação, aceite, PPPoE/senha nem ponto de acesso. Hoje o número do contrato é digitado. Faltam também **plano escolhido** e **apelido do cliente final** (o campo não existe). |
| **4. Calendário e WhatsApp** | **Falta** | Sem data da visita, técnico, cards, arrastar, nem disparo. WhatsApp é módulo opcional. |
| **5. Liberação da ONU** | Parcial | Lista pendentes, confere a serial pela etiqueta, trava de sinal, justificativa, decisão em 30 min, estados até `online`. **Falta:** mostrar **VLAN** e **PPPoE/senha** para o técnico configurar a ONU (passos 6 e 7 do PDF), e o **chamado automático à Infra** na justificativa (Externo). Roda contra mock; a escrita real depende da Wiki e do Juan. |
| **6. Fotos e O.S.** | Parcial | Cinco tipos, data/hora/GPS/contrato, redução no celular, link assinado para a Infra, foto de medição obrigatória antes de ativar. **Falta:** tela da Speed para ver as fotos; **foto de medição na ONU** (o PDF tem esta e a "medição na CTO" separadas; hoje só existe a da CTO); **fechamento da O.S.** (porta/sinal final/modelo/SN/observação) e a regra "fotos obrigatórias para fechar" (decisão da diretoria em aberto). |
| **Tela do cliente** | **Falta** | Semáforo de 3 estados, dados do cliente, sinal, histórico, alarmes, ações. Precisa de rotas de leitura novas da Wiki. |
| **Chamados de infra** | **Falta** (Externo) | Depende do endpoint da Wiki e do SLA da diretoria (SLA configurável sem código). |
| **Automações do cliente** | **Falta** (Externo) | Bloqueio, desbloqueio, reinício, troca de senha PPPoE, cancelamento com devolução da vaga. Hoje a reserva `convertida` nunca devolve a vaga. |
| **Bloqueio do parceiro inteiro** | Parcial | Bloqueia o acesso ao portal com motivo obrigatório e confirmação dupla na tela. **Falta:** o bloqueio em massa dos **clientes** dele no Voalle. |
| **Planos e financeiro** | **Falta** | Existe a tabela de planos com o valor da Speed. Faltam o **preço de venda do parceiro**, a aba financeira (pago/não pago) e o cálculo de custo, faturamento e lucro. Tudo isso pode ser derivado dos dados do portal. |
| **Dashboards do supervisor** | **Falta** | Fibra online vs PPPoE conectado, bloqueados, offline, portas ativas, financeiro, relatórios em planilha e PDF. |
| **Painel da Speed** | Parcial | Consultas por dia (com, sem e fora da área), CTOs vistas por sigla, relatório de CTOs "conferir", auditoria com filtros. **Falta:** portas ocupadas e receita por parceiro, chamados abertos, instalações fora do padrão de sinal. Indicadores exatos ainda são decisão da diretoria. |
| **Proteção e auditoria** | Parcial | Limite de ocupação por CTO (50%, por parceiro), limite de reservas, bloqueio de liberação sem justificativa, auditoria de viabilidade, reserva, ONU, usuários, 2FA e fotos. **Falta:** limite **por CTO**, liberação caso a caso, alerta de muitos chamados na mesma CTO e auditoria de contrato, bloqueio e reinício (que ainda não existem). |
| **Uso em campo** | Parcial | Responsivo e testado no celular, foto com compressão. **Falta:** tolerância a perda de conexão preservando o formulário (hoje se recarregar a página, perde). |
| **Segurança** | Feito | Senha forte, 2FA (TOTP), permissões no servidor, credenciais só no servidor, sessão de 8 h, isolamento por parceiro com 404. **Falta:** a senha PPPoE com registro de quem consultou (a senha ainda nem é exibida). |
| **Disponibilidade** | Parcial | Fonte fora do ar vira aviso claro (sem expor o sistema), log de todas as chamadas de API, idempotência na ativação. **Falta:** monitoramento no Zabbix/Grafana e o `/api/health` refletir o estado das integrações. |

## Telas do protótipo aprovado (`modelo-4.html`) ainda sem versão real

| Protótipo | Estado |
|---|---|
| Nova venda | Feito |
| Reservas | Feito |
| Painel do parceiro ("Bom dia…") | **Falta** (existe só o painel da Speed) |
| Campo (técnico no celular) | Parcial (o painel Liberar ONU é a base) |
| Clientes | **Falta** |
| Chamados | **Falta** |
| Financeiro | **Falta** |
| Mapa da rede | **Falta** |
| Resumo do mês | **Falta** |
| Avisos (sino e toasts) | Parcial (toasts e aviso de vencimento; sem sino) |

## Fases do PDF

| Fase | Itens | Pronto |
|---|---|---|
| **1. MVP** | login e perfis, viabilidade, reserva, contrato no Voalle, liberação da ONU, tela do cliente, painel admin | 5 de 7 (faltam **contrato no Voalle** e **tela do cliente**) |
| **2. Operação** | calendário, fotos e O.S., histórico de sinal, bloqueio/desbloqueio/reinício, chamados, preços e dashboard | fotos parcialmente |
| **3. Gestão** | financeiro, relatórios, WhatsApp, limites por CTO, auditoria consultável | auditoria consultável e limite de ocupação por parceiro |

## Decisões da diretoria que continuam em aberto
SLA dos chamados · divergência de porta (hoje superada pela decisão da Wiki de não vincular porta) · fotos obrigatórias para fechar a O.S. · tabela fixa ou degressiva · limite de ocupação por CTO (50% sugerido, aplicado por parceiro) · módulo de WhatsApp no piloto · indicadores do painel da Speed.
