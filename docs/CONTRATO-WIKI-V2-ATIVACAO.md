# Contrato portal Rede Neutra ↔ SpeedWiki (v2): liberação de ONU

**Estado: PROPOSTA do portal, com decisões confirmadas pela Wiki em 14 out 2026** (ver "Decisões fechadas"), escrita em 9 out 2026 a partir do teste da Wiki em produção e das respostas dela. Nada disto existe ainda, nem na Wiki nem no portal. É a primeira rota de **escrita** entre os dois: só liga com validação explícita do Juan. Itens marcados **[DECIDIR]** dependem do Juan.

Complementa o [contrato v1](CONTRATO-WIKI-V1.md) (leitura). Mesmo modelo: rotas no proxy da Wiki, resposta validada pelo portal, o que não bate com o contrato vira erro.

## O que já foi verificado (teste da Wiki, 9 out 2026)

- Autorizar pela rota do **painel** do OLTCloud (sessão web) funciona; provisionar pela API com o script "AUTENTICADOR (OLT_X)" funciona. ONU Online em ~50 s.
- A lista de ONUs pendentes traz serial, modelo, slot, pon e onu_hash, **sem sinal**.
- Depois de autorizar e antes de provisionar, a ONU existe na OLT como "Inativo", sem serviço nem PPPoE. **Ainda não confirmado** que o sinal já aparece nessa janela.
- O id da ONU muda a cada reautorização: a chave é a **serial**.
- O script AUTENTICADOR é repetível (começa desfazendo o serviço anterior).
- A saída do script traz a senha PPPoE em texto puro. Nem a Wiki nem o portal a guardam ou exibem; o próprio OLTCloud a mantém no histórico dele (fora do nosso controle).

## Decisões fechadas (resposta da Wiki, 14 out 2026)

- **Porta:** o técnico **não informa porta** e a Wiki **não vincula porta** na ativação. O campo `porta` sai do corpo de `POST /ativacoes` (o portal já não o envia) e a Wiki não precisa mais traduzir `ctoId` + porta nem responder `409 porta_ocupada`.
- **Trava de sinal reprovada:** a Wiki espera a decisão por **30 min** e, sem decisão, cancela e desautoriza. É o que o portal propõe.
- **Foto de prova no `prosseguir`:** **link assinado com expiração de 24 a 48 h**, sem conta da Infra no portal. O portal precisa gerar esse link (token assinado, só leitura de uma foto) quando existir o módulo de fotos.
- **Sinal na janela "Inativo" [RESOLVIDO em 16 out 2026]:** o teste ponta a ponta da Wiki numa ONU da Speed (autorizar, medir, provisionar, confirmar online com PPPoE no NE40) levou cerca de 70 s, e o sinal **aparece logo depois de autorizar**, com a ONU "Inativo", antes de provisionar. Fonte: leitura forçada na OLT, 3 leituras e a mediana; se a ONU recém-autorizada ainda não tiver leitura, a Wiki tenta por até 2 min e, sem sucesso, vai para `aguardando_decisao` com `motivo: "sem_leitura_de_sinal"` e `sinal: null` (o portal mostra "Não foi possível ler o sinal" e oferece medir de novo, prosseguir com justificativa ou cancelar). **Ainda sem medição:** quanto tempo o Voalle leva para sincronizar com o OLTCloud.
- **Rota oficial `POST /api/v2/ftth/equipment/auth` do OLTCloud:** o suporte não respondeu; a Wiki segue com a rota da tela, que funciona.
- **Calendário:** as rotas v2 só entram depois que a v1 estiver validada com o Codemaps liberado, e com autorização do Juan.

## Estado em 16 out 2026: construída pela Wiki, desligada

As rotas abaixo existem na Wiki, com `X-RedeNeutra-Write-Key` (valor entregue quando ligarem) e **`X-RedeNeutra-Partner` obrigatórios em todas**. `porta` é aceita e ignorada (o portal não manda). `pppLogin` e `alias` precisam ser `<contrato>-<CÓDIGO do header>` (senão `422 login_fora_do_padrao`); a mesma `idempotencyKey` devolve a mesma ativação; serial já em outra ativação aberta é `409 serial_em_ativacao`. **Atualização (16 out 2026):** a Wiki testou a v2 ponta a ponta numa ONU da Speed. As rotas de **leitura** (`GET /v2/onus/pendentes` e `GET /v2/ativacoes/{id}`) estão ativas, com a chave de escrita e o `X-RedeNeutra-Partner`; `POST /v2/ativacoes` e `/decisao` seguem em `503 ativacao_desligada` e só ligam com o **primeiro cliente real do piloto**, que depende do contrato no Voalle com login `<contrato>-JHV`. `vistaEm` nos pendentes é o horário da **consulta** (o OLTCloud não informa quando a ONU apareceu). O portal já segue tudo isso: manda o header em toda chamada, trata esses três 503 como "ainda não liberada" (o pedido fica guardado e pode ser repetido) e mostra a recusa com texto claro.

## Configuração completa da ONU (Wiki, 23 out 2026)

A ativação passou a entregar a ONU configurada, sem mudar rotas, estados nem formatos. Dentro de `provisionando`, em ordem: reset de fábrica (apaga Wi-Fi, senhas e PPPoE de cliente anterior; nunca repete em nova tentativa), AUTENTICADOR da OLT, senha web `admin` com a senha padrão da Speed (ACS), WAN de internet com IPv6 (endereço automático e prefixo delegado) e serviço `VOIP_INTERNET` (ACS), acesso remoto pela rede de gerência. Depois, vínculo com a porta da CTO e espera de Online + PPPoE. **`provisionando` passa a levar de 2,5 a 5 min**, com a ONU uns 2 min fora do ar.

- **Só ONU Huawei gerenciada pelo ACS**, fora EG8010H, 546M e 010H. Outra termina em `falha_provisionamento` (card para a equipe da Wiki); a checagem é antes do reset, então a ONU fica autorizada sem ser mexida. O portal avisa na lista de pendentes (serial que não começa com `HWTC` ou modelo recusado) e não bloqueia o envio: quem decide é a Wiki.
- **Wi-Fi não é configurado:** a ONU termina com a rede da etiqueta. O portal avisa ao concluir.
- OLTs Jaqueline e Santa Luzia (dois scripts AUTENTICADOR) vão para a equipe da Wiki.
- Corrigido pela Wiki: ITA, Esmeraldas, Laguna e Vale do Ouro (nome do script com dois espaços); VLAN do AUTENTICADOR em ITA e Nossa Fazenda; falhas silenciosas do OLTCloud agora conferidas no histórico.
- Validado pela Wiki em produção numa EG8145X6-10 de bancada (online na primeira tentativa, /56 delegado, /64 na LAN). A troca automática para `VOIP_INTERNET` ainda não rodou numa ativação completa.
- **Em aberto (Juan):** de onde vêm nome e senha do Wi-Fi (campo opcional no `POST /v2/ativacoes`, padrão por cliente ou o técnico configura) e se a Wiki deve devolver `modelo_nao_suportado` (o portal já traduz esse motivo).

## Autenticação

- **Chave própria para escrita** (ex.: `X-RedeNeutra-Write-Key`), separada da chave de leitura da v1. Vazou a de leitura? Ninguém autoriza ONU com ela.
- Mesmas regras de guarda da chave da v1 (ambiente do servidor + Vaultwarden).
- No portal, a escrita fica atrás de um interruptor (`ACTIVATION_MODE=off|mock|wiki`), **desligado por padrão**.

## Rotas

### `GET /proxy/redeneutra/v2/onus/pendentes?ctoId=<id do Codemaps>`

ONUs aguardando autorização na **OLT** que atende a CTO. A Wiki filtra pela OLT (via sigla do nome da CTO), não pela PON: 72% das caixas não têm PON no OLTCloud. A lista é curta (hoje 1 a 8 pendentes por OLT) e o técnico escolhe pela serial. O portal mostra modelo e há quanto tempo a ONU apareceu, e pede ao técnico que **confirme a serial impressa na etiqueta da ONU** (últimos dígitos) antes de enviar, para ninguém ativar a ONU pendente de outro técnico.

```json
{ "onus": [{ "serial": "HWTC6FE1FCB2", "modelo": "EG8145X6-10", "vistaEm": "2026-10-09T10:02:00-03:00" }] }
```

Slot, pon e onu_hash ficam na Wiki.

### `POST /proxy/redeneutra/v2/ativacoes`

```json
{
  "idempotencyKey": "2f6c0c9e-…",
  "ctoId": "17342",
  "porta": 5,
  "serial": "ZTEGC1234567",
  "contrato": "12345",
  "pppLogin": "12345-JHV",
  "alias": "12345-JHV",
  "sinalCtoDbm": -20.0,
  "limiteDb": 1.5
}
```

Responde `202` com `{ "ativacaoId": "...", "estado": "recebida" }`. Mesma `idempotencyKey` → mesma ativação, nunca uma segunda.

A Wiki, antes de qualquer escrita (a janela "Inativo" usa leitura **fresca** do sinal, não a última em cache; a confirmar no próximo teste):
- confere que a serial está **pendente** (senão `409 serial_nao_pendente`);
- traduz `ctoId` + `porta` para o `id_cto_porta_id` interno (rota `cto_data` do painel) e confere que a porta está livre (senão `409 porta_ocupada`);
- confere que o cliente já existe no OLTCloud (sincronizado do Voalle), achando-o pelo login PPPoE (rota de busca a mapear); se não, a ativação fica em `aguardando_cliente`;
- **serializa**: uma ativação por OLT (no piloto, uma de cada vez no total). Outra em andamento → fica na fila, estado `recebida`.

### `GET /proxy/redeneutra/v2/ativacoes/{ativacaoId}`

```json
{
  "ativacaoId": "...",
  "estado": "aguardando_decisao",
  "serial": "ZTEGC1234567",
  "sinal": { "ctoDbm": -20.0, "onuDbm": -21.6, "perdaDb": 1.6, "limiteDb": 1.5, "mediaOltcloudDbm": -21.8, "amostras": 7 },
  "prazoDecisaoAte": "2026-10-09T10:35:12-03:00",
  "motivo": null,
  "atualizadoEm": "2026-10-09T10:05:12-03:00"
}
```

Estados:

| Estado | Significado |
|---|---|
| `recebida` | na fila |
| `aguardando_cliente` | contrato existe, cliente ainda não sincronizou no OLTCloud |
| `autorizando` | etapa 1 |
| `medindo_sinal` | autorizada, sem serviço; lendo o sinal |
| `aguardando_decisao` | sinal fora da trava; espera o técnico (ver abaixo) |
| `provisionando` | etapa 2: reset, AUTENTICADOR, ACS e vínculo com a porta (ver "Configuração completa"), até 2 novas tentativas; 2,5 a 5 min |
| `online` | ONU Online (OLTCloud) **e** PPPoE autenticado no concentrador (a Wiki consulta o NE40). Só entra neste estado quando os dois confirmam |
| `falha_provisionamento` | autorizada, provisionar falhou 3 vezes; chamado aberto ao NOC; **não desautoriza** |
| `cancelada` | desautorizada antes de provisionar (decisão do técnico, ou sem decisão em 30 min) |
| `falhou` | erro antes de autorizar; `motivo` diz qual |

O portal consulta a cada poucos segundos enquanto o técnico acompanha. Webhook fica para depois.

### `POST /proxy/redeneutra/v2/ativacoes/{ativacaoId}/decisao`

Só em `aguardando_decisao`, com **prazo de 30 min** (`prazoDecisaoAte`). Sem decisão no prazo, a Wiki cancela e desautoriza (a ONU nunca teve serviço); o portal mostra a contagem regressiva e, se o prazo vencer, o técnico recomeça com uma nova ativação.

```json
{ "acao": "prosseguir", "justificativa": "Conector refeito, medição repetida com power meter." }
```

- `remedir`: a Wiki lê o sinal de novo (o técnico ajustou algo).
- `prosseguir`: exige justificativa (mínimo 10 caracteres); a Wiki provisiona. **Atualização (16 out 2026):** quem abre o chamado da Infra com as duas medições, a justificativa e a foto é o **portal**, pela rota de chamados do [contrato v3](CONTRATO-WIKI-V3-CLIENTES.md); a Wiki **não** abre card nesta decisão (evita duplicar). **Atenção ao link da foto:** as fotos ficam no portal, que exige login, e a Infra não é usuária do portal. Opções: contas `admin_speed` para a Infra, ou link assinado que expira. Decidir antes de ligar.
- `cancelar`: a Wiki desautoriza antes de provisionar; o cliente nunca teve serviço.

## Trava de sinal (regra da Speed, confirmada pelo Juan em 9 out 2026)

**Como a Speed trabalha hoje:**
1. Ao chegar no cliente, o técnico **mede o sinal na CTO** (na porta que vai usar) e **tira uma foto** da medição.
2. Instala o cliente.
3. O sinal na ONU do cliente pode ser no máximo **1,5 dB pior** que o sinal medido na CTO.

**No portal e no contrato:**
- A foto e o valor medido na CTO são **obrigatórios antes de pedir a ativação**. A foto fica no portal (com data, hora, GPS do aparelho e contrato), como previsto para o módulo de fotos.
- `POST /ativacoes` passa a levar `sinalCtoDbm` (o valor medido pelo técnico) e `limiteDb` (o limite vigente).
- **O limite é um parâmetro da Speed, não um número fixo no código:** hoje 1,5 dB, editável pelo administrador Speed no portal, com registro na auditoria. Cada ativação guarda o limite que valeu para ela.
- A Wiki autoriza, lê o sinal da ONU na janela "Inativo" e calcula a perda: `perda = sinalCtoDbm - sinalOnuDbm` (ex.: CTO -20,0 dBm e ONU -21,6 dBm → perda 1,6 dB → acima de 1,5, reprova).
- A média do OLTCloud (`box/attenuations`, sem o sentinela -99,99) deixa de ser a referência. Vira só informação extra na resposta, útil para a Infra quando o próprio sinal da CTO estiver ruim.
- Resposta da Wiki: `sinal: { ctoDbm, onuDbm, perdaDb, limiteDb, mediaOltcloudDbm, amostras }`.

**O que acontece quando reprova [DECIDIR]:**
- **Proposta do portal** (segue o planejamento original): a ativação para em `aguardando_decisao`, e o técnico escolhe entre `remedir`, `prosseguir` com justificativa (abre chamado para a Infra com as duas medições e a foto) ou `cancelar` (a Wiki desautoriza antes de provisionar).
- **Proposta da Wiki:** desautorizar automaticamente.

## Falha pela metade [DECIDIR]

Proposta da Wiki, com a qual o portal concorda: autorizou e provisionar falhou → até 2 novas tentativas; persistindo, fica **autorizada**, estado `falha_provisionamento` e chamado/card para o NOC. Não desautoriza sozinha (o técnico está em campo; desautorizar gera id novo). Única exceção: o técnico cancelar na trava de sinal.

## Cliente e alias (decidido pelo Juan, 9 out 2026)

- **O login PPPoE é o próprio código do contrato**, no padrão `CONTRATO-NOMEDOPROVEDOR`. O nome no padrão é o do **provedor parceiro**, não o do assinante: o contrato está no nome do parceiro, e o nome do assinante final continua sem ir para o Voalle, a OLT ou o OLTCloud.
- Parceiro do piloto: **JHV**. Exemplo: contrato `12345` → PPPoE `12345-JHV`.
- No AUTENTICADOR: `ppp_login` = `alias` = `<contrato>-JHV`. No corpo de `POST /ativacoes`, `pppLogin` e `alias` levam o mesmo valor.
- No portal, cada parceiro ganha um **código curto** (ex.: `JHV`), cadastrado pela Speed, usado para montar esse identificador.
- Ordem: contrato no Voalle → cliente aparece no OLTCloud (sincronização, tempo **não medido**) → autorizar. Se demorar, existe `POST /api/v2/client/create`.
- Ainda depende da Tarefa 1 do analista: quem gera o código (o Voalle ou a automação) e se o Voalle aceita esse formato como login PPPoE.

## Volume e suporte [DECIDIR]

- Serializar: uma ativação por OLT; no piloto, uma de cada vez no total. A sessão do painel é reaproveitada (cache de 40 min na Wiki).
- A capacidade real da sessão do painel não está medida (o "trava com ~6 requisições" era de outra rota).
- **Pedir agora ao suporte do OLTCloud o corpo da rota oficial** `POST /api/v2/ftth/equipment/auth`: custo zero, e tira a ativação de uma rota interna de tela que pode mudar sem aviso.

## No portal (quando for autorizado a construir)

- Registro de ativação por **serial**, com a chave de idempotência, estado e etapas; nunca a saída do script nem a senha.
- Tela do técnico: escolher a ONU pendente, informar a porta, acompanhar por etapa, decidir na trava de sinal.
- Auditoria de toda ativação, decisão e justificativa (`recordAudit`).
- Reserva vira `convertida` só com `online`.
