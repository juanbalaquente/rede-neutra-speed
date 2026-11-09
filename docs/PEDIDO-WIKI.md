# Pedido à SpeedWiki: o que falta para ligar o portal Rede Neutra

Escrito em 16 out 2026. O portal (https://redeneutra.spdlink.com.br) já está no ar e conversa com a Wiki em **v1** (viabilidade, vagas, mapa por sigla). Tudo o que está abaixo já está **construído e testado no portal contra uma Wiki de mentira**; falta só a Wiki entregar as rotas. Cada rota segue o contrato já enviado: [`CONTRATO-WIKI-V2-ATIVACAO.md`](CONTRATO-WIKI-V2-ATIVACAO.md) e [`CONTRATO-WIKI-V3-CLIENTES.md`](CONTRATO-WIKI-V3-CLIENTES.md) (formatos de entrada, saída, estados e erros). Se algo no contrato não couber na Wiki, responda com a mudança proposta e ajustamos o portal.

## O que já funciona (obrigado)

- v1: `/viabilidade`, `/ctos/{id}/vagas`, `/health` e, na v1.1, `/regioes/{sigla}/ctos`. Validados em produção com dado real.
- v3 leitura: `/clientes/{login}/status`, `POST /clientes/status` (lote) e `/clientes/{login}/sinal`. O cliente do portal já valida as respostas contra o contrato e tolera `autenticacao: desconhecido` com `motivo`.

## Regras que valem para tudo abaixo

- A chave do cliente é o **login PPPoE** `<contrato>-<CÓDIGO>` (ex.: `12345-JHV`), que é também o **alias da ONU**. O portal nunca manda nome de assinante.
- Header `X-RedeNeutra-Partner: <CÓDIGO>` em toda rota que recebe login ou id de operação/chamado; a Wiki responde `403 login_de_outro_parceiro` se o login não terminar em `-<CÓDIGO>`.
- Escrita: chave separada `X-RedeNeutra-Write-Key` e `idempotencyKey` (uuid) obrigatória; mesma chave, mesma operação, nunca duas. Resposta `202` com o id, e o portal consulta o estado a cada poucos segundos.
- Erros no formato `{"error": "<codigo>"}`, mensagens curtas em português, nunca com segredo ou saída crua de equipamento.
- **O portal nunca liga escrita sozinho**: cada modo (`ACTIVATION_MODE`, `AUTOMATION_MODE`) fica desligado até a gente validar com vocês numa ONU/contrato de teste da própria Speed.

## Atualização (16 out 2026): criação de contrato

A Wiki propôs `POST /v3/contratos` (contrato v3, seção H) e o portal já tem o lado dele pronto contra mock (`CONTRACT_MODE`): endereço estruturado, acompanhamento das etapas `contrato_criado`, `conexao_ajustada`, `endereco_gravado` e uso do login devolvido na ativação. Pontos para fechar: (1) o **cancelamento do contrato não aprovado** quando a reserva é cancelada antes da ativação: qual rota o portal chama (por exemplo `POST /v3/contratos/{operacaoId}/cancelamento`)? (2) confirmar que `resultado.login` sempre vem como `<contrato>-<CÓDIGO>` (o portal recusa qualquer outro formato); (3) `valorMensal` é o preço que a Speed cobra do parceiro pelo plano, não o preço ao assinante.

## Respondido em 18 out 2026

A Wiki respondeu às perguntas sobre contrato sem valor, aprovação, cancelamento, estado do contrato, repetição de `parcial`, conexão no cancelamento, tempo até o OLTCloud e limite por CNPJ. Respostas e efeito no portal em [`FLUXO-CONTRATO-E-CONEXAO.md`](FLUXO-CONTRATO-E-CONEXAO.md). **Atualização:** a Wiki confirmou o mapeamento velocidade → serviço (600, 700, 800 e 1000 Mbps, os quatro planos do portal), que a conexão PPPoE nasce sozinha com o contrato e que a chave "Integração" não é necessária; a configuração que falta é vincular os 4 planos da Speed (serviços 00229, 00232, 00233 e 00332) a um tipo de contrato no Voalle. **Em aberto:** o contrato de teste real (conexão, aprovação, PPPoE e suspensão), as rotas `POST /v3/contratos` e de cancelamento, e o tempo de sincronização com o OLTCloud.

## Atualização (18 out 2026): contrato SEM VALOR

**Contrato sem valor (Juan, 18 out 2026):** o contrato no Voalle **não cobra nada**. Ele existe só para **identificar o cliente** (o número do contrato é a chave) e **gerar a conexão PPPoE** (login `<contrato>-<CÓDIGO>`, ponto de acesso, perfil de velocidade no RADIUS). O parceiro **paga direto ao dono da Speed, fora do ERP**, pelo fechamento do portal (portas ativas × valor fixo por plano). O portal manda sempre `valorMensal: 0`. Perguntas:

1. Como o contrato fica sem valor no Voalle: um **serviço de valor zero** por velocidade, ou o item do contrato zerado? Funciona com o tipo de contrato "Integração"?
2. O Voalle exige **contrato aprovado** para a conexão PPPoE autenticar? Se sim, aprovem já na criação (não há cobrança).
3. A **suspensão** (`Contract/Suspend`) corta o PPPoE? Se sim, ela vira o bloqueio automático por inadimplência (o problema de "parar a cobrança" deixou de existir).
4. `409 fatura_em_aberto` sai do cancelamento: não há fatura no ERP para esses contratos.

## Atualização (18 out 2026): fluxo de contrato e conexão

Fluxo completo, matriz de falhas e roteiro do primeiro cliente real em [`FLUXO-CONTRATO-E-CONEXAO.md`](FLUXO-CONTRATO-E-CONEXAO.md). O portal agora trata `parcial` (repete com a mesma chave), `aguardando_equipe` e `falhou` depois de criar algo (trava novo pedido para não duplicar contrato). Perguntas novas:

1. **Cancelar contrato não aprovado** por API (proposta: `POST /v3/contratos/{operacaoId}/cancelamento`, seção H do contrato v3). Sem isso a Speed cancela à mão no Voalle.
2. Qual `contrato.estado` o Voalle mostra para contrato recém-criado e não aprovado? O portal assume `pendente_aprovacao`.
3. Mapeamento velocidade → serviço do Voalle para 600, 700, 800 e 1000 Mbps (e se `plano_nao_configurado` cobre os demais).
4. Quanto tempo o cliente leva para aparecer no OLTCloud depois do contrato (vamos medir no primeiro cliente real) e se o `POST /api/v2/client/create` entra no fluxo.
5. O que acontece com a conexão (login e senha) quando o contrato é cancelado.
6. Quando um `parcial` repetido com a mesma chave é seguro em cada etapa (`contrato_criado` não pode se repetir; `conexao_ajustada` e `endereco_gravado` podem?).

## Prioridade 1: destrava o painel e os alarmes (leitura)

1. **PPPoE no snapshot do NE40 para a rede neutra.** Vocês já responderam que vão incluir os logins no poller (pergunta 1). Precisamos de: `autenticacao.estado` (`conectado`/`desconectado`), `ip` e `desde` por login, e o `POST /clientes/status` servindo isso do snapshot. Qualquer intervalo até 15 min serve. Quando entrar, a tela do cliente deixa de mostrar "leitura do PPPoE ainda não disponível" e o painel mostra fibra online e PPPoE conectado lado a lado.
2. **Incidente por CTO (pergunta 2):** `GET /ctos/{ctoId}/incidente` com `aberto`, `desde` e `tipo` (isolada ou massiva), a partir do `cto-off-monitor`. Alimenta o aviso "sua CTO está fora" sem o parceiro abrir chamado.
3. **VLAN:** hoje `onu.vlan` vem null quando há mais de uma. Se possível, devolver `vlans: [{ tipo: "gerencia"|"servico", id }]`. Não é bloqueante.

## Prioridade 2: chamados de infraestrutura (seção D do v3)

Rotas: `POST /v3/chamados`, `GET /v3/chamados/{id}`, `POST /v3/chamados/{id}/mensagens`. Tipos: `cto_com_problema`, `porta_off`, `conferencia_porta`, `sinal_fora_padrao_cto`, `rompimento_regional`, `trava_sinal` (automático, `origem: "sistema"`).

Decisões que precisamos de vocês:

- **Pergunta 4:** onde o chamado cai na Wiki. Proposta: `POST /proxy/kanban/cards` (`X-Kanban-Key`, `external_ref` = `chamadoId`) numa coluna DEMANDAS de um board da Infra, com `source: "redeneutra"`. O estado do chamado sai da coluna do card (DEMANDAS = `aberto`, intermediárias = `em_atendimento`, concluído = `resolvido`). Qual board e quais colunas? Se preferirem a tabela `incidents`, precisa de endpoint novo.
- **Pergunta 3:** o portal manda as fotos como **link assinado de 48 h**, sem conta da Infra. A Wiki baixa e guarda na criação do chamado (o link expira)?
- **Trava de sinal:** quando o técnico escolhe `prosseguir`, **o portal abre o chamado** `trava_sinal` por esta rota. A Wiki **não deve abrir card próprio** na decisão `prosseguir` do v2 (só provisionar), para a Infra não receber dois cards. Isso muda o texto original do v2 (já ajustado no contrato).
- **SLA:** o portal manda `slaHoras` por chamado (configurável pela Speed, valores ainda sob decisão da diretoria). A Wiki só guarda e mostra à Infra.
- Só mensagens com `autor: infra` voltam para o portal; as do parceiro e do sistema já estão lá.

## Prioridade 3: ativação de ONU (v2): construída e desligada pela Wiki (16 out)

O portal já está alinhado ao que a Wiki informou (header de parceiro em toda chamada, 503 de rota desligada tratados, `serial_em_ativacao` e `login_fora_do_padrao` com texto claro, `porta` não enviada, `vistaEm` tratado como hora da consulta). **Falta a Wiki:** entregar a chave de escrita, validar a leitura de sinal ao vivo e fazer o teste com uma ONU da Speed; depois o Juan valida e liga `ACTIVATION_MODE=wiki`. O texto abaixo segue como referência.

Rotas: `GET /v2/onus/pendentes?ctoId=`, `POST /v2/ativacoes`, `GET /v2/ativacoes/{id}`, `POST /v2/ativacoes/{id}/decisao`. Regras já combinadas (decisões de 14 out): login PPPoE = `<contrato>-<CÓDIGO>` e alias da ONU igual ao login; trava de sinal com limite editável pela Speed (referência = medição do técnico na CTO, com foto; padrão 1,5 dB); estado `aguardando_decisao` com prazo de 30 min; falha de provisionamento deixa a ONU **autorizada** em `falha_provisionamento`, sem desautorizar; senha PPPoE nunca em resposta, log ou cache.

Pontos em aberto (marcados `[DECIDIR]` no contrato v2): o que acontece quando o sinal reprova e o técnico cancela; volume esperado e quem atende em caso de falha. Para testar: uma ONU da própria Speed, como no teste de 9 out.

## Prioridade 4: ações sobre o cliente (seção C do v3)

1. **Reinício** (`POST /v3/clientes/{login}/reinicio`): a base (ACS) já existe. Só vira `concluida` quando o uptime da ONU volta a zero em até 5 min; sem confirmação é `sem_confirmacao`, não falha. Sem ACS: `falhou` com `motivo: "sem_acs"`.
2. **Bloqueio e desbloqueio** (`POST /v3/clientes/{login}/bloqueio`, `acao: bloquear|desbloquear`): depende da rota do Voalle para bloqueio administrativo, que ainda não conhecemos (aguardando o analista de Voalle). Se não houver API, a operação vira `aguardando_equipe` e abre card no Kanban da Speed. O bloqueio **mantém a porta e a cobrança**.
3. **Cancelamento** (`POST /v3/clientes/{login}/cancelamento`): três etapas com estado próprio (`contrato_encerrado` no Voalle, `onu_removida` no OLTCloud, `porta_devolvida` no Codemaps). Falha no meio deixa `parcial`; repetir a mesma `idempotencyKey` continua de onde parou. Pergunta: dá para consultar fatura em aberto no Voalle e responder `409 fatura_em_aberto` antes de qualquer etapa?
4. `GET /v3/operacoes/{id}` para acompanhar as três ações (estados `recebida`, `executando`, `concluida`, `parcial`, `sem_confirmacao`, `aguardando_equipe`, `falhou`).

## Senha PPPoE: resolvido, sem rota

**Decisão da Speed (16 out 2026):** a rede neutra usa a **mesma senha PPPoE padrão** dos demais clientes da Speed. A Wiki a grava ao criar o contrato; não há rota de senha, nem entrega de senha na criação do contrato, nem ação de "trocar senha". O parceiro recebe a senha padrão pelo canal comercial, fora do sistema. A ativação da ONU só precisa do login: o OLTCloud busca a senha sozinho ao configurar a ONU, e o técnico não digita senha no fluxo normal.

## Novo pedido: sinal da base em lote

O portal agora mostra a qualidade média do sinal da base e os clientes com mais quedas. Hoje ele faz **uma chamada `GET /clientes/{login}/sinal` por cliente** (de 5 em 5, com resultado guardado por 10 min), o que é aceitável no piloto mas pesa com centenas de clientes. Pedido opcional: `POST /v3/clientes/sinal-resumo` com `{ "logins": [...], "dias": 30 }` (até 200) devolvendo, por login, `mediaDbm`, `ultimoDbm`, `piorDbm` e a lista de quedas (`inicio`, `fim`, `tipo`), sempre do histórico (`onu_signal_history`). Mesmas regras de header e de login de outro parceiro.

## Pequenas perguntas de dados

- A CTO `52108` (`CTO_12_P2_P4_R1`) vem com `totalVagas: 0`, e o portal trata como "conferir". É esperado (sem caixa no OLTCloud) ou dado incompleto?
- Qual endereço fica perto da CTO `24109` (ITA, 3 de 16 livres no seu teste)? Queremos validar a vaga pelo fluxo completo do portal.
- Confirmam que a ONU pode ser achada **só por alias** (casamento exato)? Se preferirem receber também a **serial** (o portal já tem da ativação), podemos mandar nos dois.

## Como vamos validar cada entrega

1. Vocês avisam qual rota entrou. Nós trocamos o modo correspondente no servidor (`CLIENT_STATUS_MODE`, `AUTOMATION_MODE`, `ACTIVATION_MODE`).
2. Se a resposta não bater com o contrato, o portal registra o campo exato (`fora do contrato v3 (campo: motivo)`) e a gente envia o caso.
3. Escrita só é testada com validação explícita do Juan, numa ONU ou contrato de teste da Speed.

## Ordem sugerida

1 → 2 → 3 (chamados) → 4.1 (reinício) → ativação (v2) → 4.3 → 4.2. Os itens de Voalle (bloqueio, cancelamento e senha) dependem de resposta do analista e podem andar em paralelo.
