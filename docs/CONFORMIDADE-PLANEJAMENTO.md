# Conformidade com o planejamento original

Comparação do que o portal faz hoje com o [`planejamento.pdf`](planejamento.pdf) (@Guilherme, 5 out 2026). Conferida em 15 out 2026 contra o código, os testes e o portal rodando, e **atualizada na noite de 15 out** depois das instalações, agenda, financeiro e dos itens de interface.

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
| **3. Contrato no Voalle** | Parcial (**Externo** para o Voalle) | **Feito no portal:** plano, apelido do cliente final (nunca vai para o Voalle), data da visita e técnico, exigidos antes de liberar a ONU; o formulário abre ao reservar. **Falta (Externo):** criação do contrato, aceite, PPPoE/senha e ponto de acesso no Voalle. O número do contrato ainda é digitado. |
| **4. Calendário e WhatsApp** | Parcial | **Feito:** agenda em dia, semana e mês, cards com contrato, apelido, CTO, plano e técnico, filtro por técnico, arrastar para reagendar (vira "reagendada", auditado), visita "em execução" ao liberar a ONU, "concluída" ao fechar a O.S. e aviso de visita atrasada. **Falta:** disparo diário por WhatsApp (módulo opcional) e o reenvio manual. |
| **5. Liberação da ONU** | Parcial | Lista pendentes, confere a serial pela etiqueta, trava de sinal, justificativa, decisão em 30 min, estados até `online` e **mostra a VLAN e o login a configurar** (a VLAN vem da Wiki quando ela informar). **Falta:** o chamado automático à Infra na justificativa (**Externo**). Roda contra mock; a escrita real depende da Wiki e do Juan. |
| **6. Fotos e O.S.** | Feito | Seis tipos (o checklist do PDF mais a medição na CTO), data/hora/GPS/contrato, redução no celular, **tela Instalações** para o parceiro e a Speed (galeria, mapa, link assinado de 48 h para a Infra) e **fechamento da O.S.** (sinal final, modelo e serial da ONU, porta opcional, observação) exigindo as fotos; a Speed pode tornar as fotos opcionais (decisão da diretoria em aberto). |
| **Tela do cliente** | Parcial | Semáforo de fibra, PPPoE e contrato com idade do dado, ONU, sinal de 7/30/90 dias com mínimo aceitável e quedas, consulta ao vivo, ações (bloquear, reiniciar, cancelar) e alarmes de estado atual no painel e no sino. Roda contra mock. **Falta (Externo):** as rotas de leitura da Wiki (v3, seção A) e alarme por transição. |
| **Chamados de infra** | Parcial | Abertura, lista, histórico, resposta, reenvio, prazo (SLA por tipo editável pela Speed, sem código), atraso no sino e no painel, e chamado automático da trava de sinal. Roda contra mock. **Falta (Externo):** as rotas da Wiki (v3, seção D) e os valores de SLA da diretoria. Fotos no formulário ainda não têm tela. |
| **Automações do cliente** | Parcial (**Externo** para a execução real) | **Feito no portal:** bloquear, desbloquear, reiniciar a ONU e cancelar (só supervisor), com confirmação, motivo, etapas visíveis, repetição de operação parcial e **vaga devolvida** ao cancelar; contra mock, com o cliente real da Wiki já escrito conforme o contrato v3. **Falta (Externo):** as rotas v3 da Wiki, a rota do Voalle para bloqueio administrativo e a regra de fatura em aberto. **Falta:** troca de senha PPPoE (depende de onde a senha mora). |
| **Bloqueio do parceiro inteiro** | Parcial | Bloqueia o acesso ao portal com motivo obrigatório e confirmação dupla na tela. **Falta:** o bloqueio em massa dos **clientes** dele no Voalle. |
| **Planos e financeiro** | Feito (primeira entrega do PDF) | Preço de venda por plano (supervisor), valor fixo da Speed por porta ativada (admin), custo, faturamento previsto, lucro e margem por plano, **marcação manual de pago/não pago** por cliente e mês, recebido e em aberto, exportação em planilha (fechamento e base de clientes). **Falta:** PDF (só CSV hoje) e as formas 2 e 3 de alimentar o pagamento (arquivo de retorno, integração). |
| **Dashboards do supervisor** | Parcial | Painel do parceiro: portas ativas, instalações no mês, O.S. pendentes, reservas, visitas hoje e atrasadas, gráficos dos últimos 6 meses, portas por plano. Fibra online vs PPPoE conectado, bloqueados, offline e chamados com SLA já aparecem (contra mock; reais dependem da Wiki v3). **Falta:** qualidade de sinal da base, relatório em PDF. |
| **Painel da Speed** | Parcial | Consultas por dia (com, sem e fora da área), CTOs vistas por sigla, relatório de CTOs "conferir", auditoria com filtros. **Falta:** portas ocupadas e receita por parceiro, chamados abertos, instalações fora do padrão de sinal. Indicadores exatos ainda são decisão da diretoria. |
| **Proteção e auditoria** | Parcial | Limite de ocupação por CTO (50%, por parceiro), limite de reservas, bloqueio de liberação sem justificativa, auditoria de viabilidade, reserva, ONU, usuários, 2FA e fotos. **Falta:** limite **por CTO**, liberação caso a caso, alerta de muitos chamados na mesma CTO e auditoria de contrato, bloqueio e reinício (que ainda não existem). |
| **Uso em campo** | Feito | Responsivo e testado no celular, foto com compressão, e o que foi digitado nos formulários (dados do cliente, liberação da ONU, fechamento da O.S.) **sobrevive ao recarregar a página**; um erro de tela mostra uma mensagem com botão de recarregar em vez de tela branca. |
| **Segurança** | Feito | Senha forte, 2FA (TOTP), permissões no servidor, credenciais só no servidor, sessão de 8 h, isolamento por parceiro com 404. A senha PPPoE **não será exibida nem trocada pelo portal** (decisão da Speed, 16 out 2026: senha padrão gravada pela Wiki e entregue pelo canal comercial). |
| **Disponibilidade** | Parcial | Fonte fora do ar vira aviso claro (sem expor o sistema), faixa vermelha para a Speed, log de todas as chamadas, idempotência na ativação e `/api/health` com o estado da rede (`rede`), cacheado, para o Zabbix. **Falta:** ligar de fato o monitoramento no Zabbix/Grafana. |

## Telas do protótipo aprovado (`modelo-4.html`) ainda sem versão real

| Protótipo | Estado |
|---|---|
| Nova venda | Feito |
| Reservas | Feito |
| Painel do parceiro ("Bom dia…") | Feito (sem fibra/PPPoE, que dependem da rede) |
| Campo (técnico no celular) | Feito (painel Liberar ONU, fotos, O.S.) |
| Clientes | **Falta** |
| Chamados | Feito no portal (mock) |
| Financeiro | Feito |
| Mapa da rede | Parcial: painel da Speed com a rede inteira por sigla (pontos coloridos por estado), sem mapa de fundo; o mapa do parceiro e o "simular falha" do protótipo não existem |
| Resumo do mês | **Falta** |
| Avisos (sino e toasts) | Feito |

## Fases do PDF

| Fase | Itens | Pronto |
|---|---|---|
| **1. MVP** | login e perfis, viabilidade, reserva, contrato no Voalle, liberação da ONU, tela do cliente, painel admin | 7 de 7 no portal; **contrato no Voalle**, liberação da ONU e tela do cliente rodam contra mock e esperam as rotas da Wiki (**Externo**) |
| **2. Operação** | calendário, fotos e O.S., histórico de sinal, bloqueio/desbloqueio/reinício, chamados, preços e dashboard | **calendário, fotos e O.S., preços e dashboard feitos**; faltam histórico de sinal, bloqueio/desbloqueio/reinício e chamados (**Externos**) |
| **3. Gestão** | financeiro, relatórios, WhatsApp, limites por CTO, auditoria consultável | financeiro e planilhas, auditoria consultável e limite de ocupação por parceiro; faltam WhatsApp, limite por CTO e PDF |

## Decisões da diretoria que continuam em aberto
SLA dos chamados · divergência de porta (hoje superada pela decisão da Wiki de não vincular porta) · fotos obrigatórias para fechar a O.S. · tabela fixa ou degressiva · limite de ocupação por CTO (50% sugerido, aplicado por parceiro) · módulo de WhatsApp no piloto · indicadores do painel da Speed.
