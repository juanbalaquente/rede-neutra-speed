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

## Prioridade 3: ativação de ONU (v2)

Rotas: `GET /v2/onus/pendentes?ctoId=`, `POST /v2/ativacoes`, `GET /v2/ativacoes/{id}`, `POST /v2/ativacoes/{id}/decisao`. Regras já combinadas (decisões de 14 out): login PPPoE = `<contrato>-<CÓDIGO>` e alias da ONU igual ao login; trava de sinal com limite editável pela Speed (referência = medição do técnico na CTO, com foto; padrão 1,5 dB); estado `aguardando_decisao` com prazo de 30 min; falha de provisionamento deixa a ONU **autorizada** em `falha_provisionamento`, sem desautorizar; senha PPPoE nunca em resposta, log ou cache.

Pontos em aberto (marcados `[DECIDIR]` no contrato v2): o que acontece quando o sinal reprova e o técnico cancela; volume esperado e quem atende em caso de falha. Para testar: uma ONU da própria Speed, como no teste de 9 out.

## Prioridade 4: ações sobre o cliente (seção C do v3)

1. **Reinício** (`POST /v3/clientes/{login}/reinicio`): a base (ACS) já existe. Só vira `concluida` quando o uptime da ONU volta a zero em até 5 min; sem confirmação é `sem_confirmacao`, não falha. Sem ACS: `falhou` com `motivo: "sem_acs"`.
2. **Bloqueio e desbloqueio** (`POST /v3/clientes/{login}/bloqueio`, `acao: bloquear|desbloquear`): depende da rota do Voalle para bloqueio administrativo, que ainda não conhecemos (aguardando o analista de Voalle). Se não houver API, a operação vira `aguardando_equipe` e abre card no Kanban da Speed. O bloqueio **mantém a porta e a cobrança**.
3. **Cancelamento** (`POST /v3/clientes/{login}/cancelamento`): três etapas com estado próprio (`contrato_encerrado` no Voalle, `onu_removida` no OLTCloud, `porta_devolvida` no Codemaps). Falha no meio deixa `parcial`; repetir a mesma `idempotencyKey` continua de onde parou. Pergunta: dá para consultar fatura em aberto no Voalle e responder `409 fatura_em_aberto` antes de qualquer etapa?
4. `GET /v3/operacoes/{id}` para acompanhar as três ações (estados `recebida`, `executando`, `concluida`, `parcial`, `sem_confirmacao`, `aguardando_equipe`, `falhou`).

## Prioridade 5: senha PPPoE sob demanda (seção B do v3)

`GET /v3/clientes/{login}/senha-pppoe`, `Cache-Control: no-store`, nunca em log ou cache. O portal exibe uma vez e registra na auditoria quem pediu, sem gravar o valor. Depende de onde a senha mora (Voalle, `authentication_contracts.password`?), então fica para depois do analista.

## Pequenas perguntas de dados

- A CTO `52108` (`CTO_12_P2_P4_R1`) vem com `totalVagas: 0`, e o portal trata como "conferir". É esperado (sem caixa no OLTCloud) ou dado incompleto?
- Qual endereço fica perto da CTO `24109` (ITA, 3 de 16 livres no seu teste)? Queremos validar a vaga pelo fluxo completo do portal.
- Confirmam que a ONU pode ser achada **só por alias** (casamento exato)? Se preferirem receber também a **serial** (o portal já tem da ativação), podemos mandar nos dois.

## Como vamos validar cada entrega

1. Vocês avisam qual rota entrou. Nós trocamos o modo correspondente no servidor (`CLIENT_STATUS_MODE`, `AUTOMATION_MODE`, `ACTIVATION_MODE`).
2. Se a resposta não bater com o contrato, o portal registra o campo exato (`fora do contrato v3 (campo: motivo)`) e a gente envia o caso.
3. Escrita só é testada com validação explícita do Juan, numa ONU ou contrato de teste da Speed.

## Ordem sugerida

1 → 2 → 3 (chamados) → 4.1 (reinício) → ativação (v2) → 4.3 → 4.2 → 5. Os itens de Voalle (bloqueio, cancelamento e senha) dependem de resposta do analista e podem andar em paralelo.
