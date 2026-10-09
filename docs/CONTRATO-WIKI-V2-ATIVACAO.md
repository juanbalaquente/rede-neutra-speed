# Contrato portal Rede Neutra ↔ SpeedWiki (v2): liberação de ONU

**Estado: PROPOSTA do portal**, escrita em 9 out 2026 a partir do teste da Wiki em produção e das respostas dela. Nada disto existe ainda, nem na Wiki nem no portal. É a primeira rota de **escrita** entre os dois: só liga com validação explícita do Juan. Itens marcados **[DECIDIR]** dependem do Juan.

Complementa o [contrato v1](CONTRATO-WIKI-V1.md) (leitura). Mesmo modelo: rotas no proxy da Wiki, resposta validada pelo portal, o que não bate com o contrato vira erro.

## O que já foi verificado (teste da Wiki, 9 out 2026)

- Autorizar pela rota do **painel** do OLTCloud (sessão web) funciona; provisionar pela API com o script "AUTENTICADOR (OLT_X)" funciona. ONU Online em ~50 s.
- A lista de ONUs pendentes traz serial, modelo, slot, pon e onu_hash, **sem sinal**.
- Depois de autorizar e antes de provisionar, a ONU existe na OLT como "Inativo", sem serviço nem PPPoE. **Ainda não confirmado** que o sinal já aparece nessa janela.
- O id da ONU muda a cada reautorização: a chave é a **serial**.
- O script AUTENTICADOR é repetível (começa desfazendo o serviço anterior).
- A saída do script traz a senha PPPoE em texto puro. Nem a Wiki nem o portal a guardam ou exibem; o próprio OLTCloud a mantém no histórico dele (fora do nosso controle).

## Autenticação

- **Chave própria para escrita** (ex.: `X-RedeNeutra-Write-Key`), separada da chave de leitura da v1. Vazou a de leitura? Ninguém autoriza ONU com ela.
- Mesmas regras de guarda da chave da v1 (ambiente do servidor + Vaultwarden).
- No portal, a escrita fica atrás de um interruptor (`ACTIVATION_MODE=off|mock|wiki`), **desligado por padrão**.

## Rotas

### `GET /proxy/redeneutra/v2/onus/pendentes?ctoId=<id do Codemaps>`

ONUs aguardando autorização na OLT que atende a CTO. Só o necessário para o técnico achar a dele.

```json
{ "onus": [{ "serial": "ZTEGC1234567", "modelo": "F670L", "vistaEm": "2026-10-09T10:02:00-03:00" }] }
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
  "pppLogin": "L12345",
  "alias": "12345-…"
}
```

Responde `202` com `{ "ativacaoId": "...", "estado": "recebida" }`. Mesma `idempotencyKey` → mesma ativação, nunca uma segunda.

A Wiki, antes de qualquer escrita:
- confere que a serial está **pendente** (senão `409 serial_nao_pendente`);
- traduz `ctoId` + `porta` para o `id_cto_porta_id` interno (rota `cto_data` do painel) e confere que a porta está livre (senão `409 porta_ocupada`);
- confere que o cliente já existe no OLTCloud (sincronizado do Voalle); se não, a ativação fica em `aguardando_cliente`;
- **serializa**: uma ativação por OLT (no piloto, uma de cada vez no total). Outra em andamento → fica na fila, estado `recebida`.

### `GET /proxy/redeneutra/v2/ativacoes/{ativacaoId}`

```json
{
  "ativacaoId": "...",
  "estado": "aguardando_decisao",
  "serial": "ZTEGC1234567",
  "sinal": { "medidoDbm": -24.9, "mediaCtoDbm": -21.8, "diferenca": 3.1, "amostras": 7 },
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
| `provisionando` | etapa 2 (AUTENTICADOR), até 2 novas tentativas |
| `online` | ONU Online e PPPoE autenticou |
| `falha_provisionamento` | autorizada, provisionar falhou 3 vezes; chamado aberto ao NOC; **não desautoriza** |
| `cancelada` | desautorizada antes de provisionar (decisão do técnico) |
| `falhou` | erro antes de autorizar; `motivo` diz qual |

O portal consulta a cada poucos segundos enquanto o técnico acompanha. Webhook fica para depois.

### `POST /proxy/redeneutra/v2/ativacoes/{ativacaoId}/decisao`

Só em `aguardando_decisao`.

```json
{ "acao": "prosseguir", "justificativa": "Conector refeito, medição repetida com power meter." }
```

- `remedir`: a Wiki lê o sinal de novo (o técnico ajustou algo).
- `prosseguir`: exige justificativa (mínimo 10 caracteres); a Wiki provisiona **e abre chamado para a Infra** com sinal medido, média e justificativa.
- `cancelar`: a Wiki desautoriza antes de provisionar; o cliente nunca teve serviço.

## Trava de sinal [DECIDIR]

**Divergência entre a proposta da Wiki e o planejamento original:**
- **Wiki:** sinal reprovado → desautoriza automaticamente.
- **Planejamento (PDF):** diferença acima de 1,5 da média da CTO → "só prossegue com **justificativa**, que abre chamado automático para a Infra".

**Proposta do portal:** seguir o planejamento, com o estado `aguardando_decisao` acima. O técnico em campo decide entre remedir, prosseguir com justificativa (e chamado) ou cancelar, e a Wiki nunca provisiona sem uma das três. Desautorizar sozinho tiraria do técnico a chance de corrigir um conector, e um id novo é gerado a cada reautorização.

**Regras do cálculo (para a Wiki confirmar):**
- A média da CTO exclui o sentinela `-99.99` e ONUs offline.
- **Amostra mínima:** com menos de N leituras na CTO (sugestão: 3), a média não serve. É o caso comum na FAT, com 19 clientes para 111 CTOs. Nesse caso, comparar com uma **faixa absoluta** a definir pela Infra (ex.: entre -27 e -15 dBm).
- A resposta traz `amostras` para o técnico ver em que se baseia a trava.

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
