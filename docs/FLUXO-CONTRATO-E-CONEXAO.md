# Criação de contrato e conexão: fluxo completo

Atualizado em 18 out 2026. Une o que o planejamento pede (etapa 3), o que a Wiki já construiu (`contracts/create`, 16 out) e o que o portal faz. Contrato técnico da rota: [`CONTRATO-WIKI-V3-CLIENTES.md`](CONTRATO-WIKI-V3-CLIENTES.md), seção H. Pedido à Wiki: [`PEDIDO-WIKI.md`](PEDIDO-WIKI.md).

**Contrato sem valor (Juan, 18 out 2026):** o contrato no Voalle **não cobra nada**. Ele existe só para **identificar o cliente** (o número do contrato é a chave) e **gerar a conexão PPPoE** (login `<contrato>-<CÓDIGO>`, ponto de acesso, perfil de velocidade no RADIUS). O parceiro **paga direto ao dono da Speed, fora do ERP**, pelo fechamento do portal (portas ativas × valor fixo por plano).

O que o parceiro pede é **uma ação só** ("Criar contrato"). Por baixo, três coisas acontecem em três sistemas, em ordem.

## 1. Sequência

```
Parceiro (portal)            Portal                    Wiki                       Voalle / OLTCloud
─────────────────            ──────                    ────                       ─────────────────
reserva a vaga (48 h)
preenche plano, visita,
técnico (formulário)
informa o endereço     ─▶  POST /v3/contratos  ─▶  contracts/create       ─▶  1. cria o contrato no nome do PARCEIRO
de instalação              (idempotencyKey,          (nenhum nome de              (SEM VALOR: só identifica)
                            CNPJ, plano, CTO,         assinante)             2. a conexão PPPoE nasce junto, login = nº do
                            endereço, posição)                                    contrato; a Wiki troca para <contrato>-<CÓDIGO>,
                                                                                 grava a senha padrão da Speed e define o
                                                                                 ponto de acesso pela sigla da CTO
                                                                              3. grava o endereço REAL do assinante só na
                                                                                 conexão (API de mapas), com a coordenada
                           ◀─ resultado: contrato 33431, login 33431-JHV
a reserva deixa de ter prazo
(não expira, não cancela)
técnico chega, liga a ONU
"Liberar ONU"          ─▶  POST /v2/ativacoes  ─▶  autoriza a ONU no OLTCloud ─▶  o cliente já precisa existir no OLTCloud
                           (login do contrato)      mede o sinal, provisiona
                                                    confirma online + PPPoE
ONU online             ◀─                          [se o Voalle exigir] aprova    ─▶  a conexão fica ativa; NADA é cobrado no ERP

porta ativa conta no fechamento do PORTAL ─▶ o dono da Speed cobra o parceiro por fora do ERP
```

Regras que valem em todo o fluxo:

- **Quem é o cliente do Voalle é o parceiro** (um CNPJ com todos os contratos). O nome do assinante nunca sai do portal.
- **O contrato não tem valor** (`valorMensal: 0`, o portal sempre manda zero). A velocidade do plano só escolhe o serviço/perfil no Voalle e no RADIUS. **A cobrança do parceiro é do portal**, não do ERP: o "fechamento do mês" é o documento de cobrança.
- O Voalle **sobrescreve o endereço principal do cliente a cada contrato**. Por isso a Wiki manda sempre o endereço do cadastro do parceiro e grava o do assinante só na conexão.
- Login `<contrato>-<CÓDIGO>` (ex.: `33431-JHV`) é também o **alias da ONU**. O portal recusa qualquer login devolvido fora desse formato.
- **Senha PPPoE:** a Wiki grava a senha padrão da Speed ao criar o contrato. O portal nunca a vê, e a ativação só precisa do login (o OLTCloud busca a senha sozinho).
- Ponto de acesso (concentrador) pela sigla da CTO: R1 = 2, ITA = 3, FAT = 11. É a Wiki quem aplica; o portal só manda `ctoId`.

## 2. Cobrança: pelo portal, fora do ERP

Como o contrato no Voalle não tem valor, **o fechamento do portal é o documento de cobrança**:

- **Regra (padrão atual):** a porta é cobrada em **todo mês em que esteve ativa em algum momento**, com o **mês cheio** tanto no mês da ativação (O.S. fechada) quanto no do cancelamento. Cliente bloqueado continua cobrado (mantém a porta). O valor é o fixo do plano, definido pela Speed.
- **O passado não muda:** o fechamento de um mês não diminui quando um cliente é cancelado depois (o portal guarda a data do cancelamento, migration `0013`). Antes desta correção, cliente cancelado sumia de todos os meses.
- **Para a Speed:** Painel da rede → "Cobrança dos parceiros", por mês, com o total de cada parceiro e o **demonstrativo** em planilha (contrato, login PPPoE, plano, CTO, ativação, cancelamento, valor).
- **Para o parceiro:** Financeiro → "Fechamento (planilha)", com a mesma regra, para conferir.
- **Decisão em aberto:** mês cheio ou proporcional (na ativação e no cancelamento). Trocar a regra é mudar uma função (`financeForPartner`), sem mexer no resto.

## 3. O que o portal garante

| Garantia | Como |
|---|---|
| Nunca dois contratos para a mesma reserva | Índice único no banco (um pedido vivo por reserva), idempotência por chave, e **bloqueio de novo pedido se o anterior falhou depois de criar algo** (`contrato_parcial`) |
| Pedido que não chegou à Wiki não se perde | Fica `recebida` e "Reenviar" repete com a mesma chave |
| Pedido que parou no meio continua | Estado `parcial`: "Repetir" manda a mesma chave e a Wiki continua de onde parou |
| Etapa manual da equipe | Estado `aguardando_equipe`, visível ao parceiro e ao painel da Speed |
| A reserva não vira lixo | Com contrato pedido a reserva **não expira e não cancela** (o PDF manda: "ao criar o contrato a reserva deixa de ter prazo") |
| Ninguém fica preso | A Speed pode **abandonar** o contrato: cancela a reserva, devolve a vaga e registra o número na auditoria para cancelar no Voalle |
| Resposta estranha não passa | Login diferente de `<contrato>-<CÓDIGO>` marca o pedido como `falhou` (`resposta_inconsistente`) e trava novo pedido |
| Nada de contrato órfão sem aviso | Painel da Speed e sino listam: pedido não enviado, sem terminar (15 min), parcial, etapa manual, falhou depois de criar, e contrato sem instalação há 7 dias |
| Ativação sem contrato é impossível | Com `CONTRACT_MODE` ligado a ONU só é liberada com o login do contrato criado; o número digitado é ignorado |

## 4. Matriz de falhas

| O que acontece | Estado no portal | O parceiro vê | Quem resolve |
|---|---|---|---|
| Wiki fora do ar ao pedir | `recebida` (sem id da Wiki) | "Pedido guardado" + Reenviar | Parceiro (Reenviar) |
| Wiki recusa: parceiro sem cadastro no Voalle | `falhou` (nada criado) | Texto claro, pode pedir de novo | Speed cadastra o parceiro; depois o parceiro tenta |
| Wiki recusa: plano sem serviço configurado | `falhou` (nada criado) | Texto claro | Speed/Wiki configuram o plano |
| Parou numa etapa (ex.: concentrador sem resposta) | `parcial` | Etapas + "Repetir agora" | Parceiro repete; se persistir, Speed |
| Etapa manual (ex.: aprovação ou endereço) | `aguardando_equipe` | "A equipe da Speed vai concluir" | Speed |
| Falhou **depois** de criar o contrato | `falhou` com etapa concluída | "Criado só em parte. Não crie outro." | **Speed** conclui ou cancela no Voalle e abandona no portal |
| Login devolvido fora do padrão | `falhou` (`resposta_inconsistente`) | idem | Speed |
| Cliente desistiu depois do contrato | `concluida`, reserva `ativa` | (parceiro não cancela) | Speed abandona; cancela no Voalle |
| Contrato criado e a instalação não acontece | `concluida` há 7+ dias | — | Alerta à Speed |

## 5. Entre o contrato e a ONU

A autorização da ONU só funciona quando o cliente **já existe no OLTCloud**. A sincronização Voalle → OLTCloud nunca foi medida. O portal já tem o estado `aguardando_cliente` na ativação ("O contrato ainda não chegou ao sistema de rede. Aguarde alguns minutos."); se a espera for longa, a Wiki cogita `POST /api/v2/client/create` no OLTCloud. **Medir isso no primeiro cliente real.**

Enquanto o contrato não é aprovado, a leitura de status do cliente (v3) devolve o estado do contrato como `pendente_aprovacao` (o portal já entende; estado desconhecido vira "Sem leitura" sem derrubar a tela).

## 6. Roteiro do primeiro cliente real (JHV)

Pré-requisitos (fora do portal):
1. Voalle: tipo de contrato com "Integração" ligada e campanha "E-commerce - Integração" configurados.
2. Parceiro JHV cadastrado no Voalle com **CNPJ e endereço completos**.
3. Wiki: serviço do Voalle mapeado para cada velocidade (600, 700, 800 e 1000 Mbps) e a chave de escrita.
4. Portal: JHV cadastrado com código `JHV`, siglas liberadas, preços e limites; 2FA religado; conta de teste desativada.

Passos, com o resultado esperado e a reversão:

| # | Ação | Esperado | Se der errado |
|---|---|---|---|
| 1 | Ligar `CONTRACT_MODE=wiki` no `.env` e recriar a API | `/api/health` ok | Voltar para `off` |
| 2 | Reservar uma vaga e preencher plano, visita e técnico | Reserva ativa | — |
| 3 | Criar o contrato com o endereço real | Contrato `NNNNN` e login `NNNNN-JHV` em até ~1 min; três etapas concluídas | Matriz da seção 3 |
| 4 | Conferir no Voalle | Contrato no nome do parceiro, **não aprovado**; conexão com login e ponto de acesso certos; endereço do assinante na conexão | Speed corrige e abandona no portal |
| 5 | Conferir a leitura do cliente (`CLIENT_STATUS_MODE=wiki`) | Contrato `pendente_aprovacao`; ONU ainda 404 | — |
| 6 | **Medir** quanto tempo o cliente leva para aparecer no OLTCloud | Anotar o tempo | Se longo, avaliar `client/create` |
| 7 | Ligar `ACTIVATION_MODE=wiki` (com a Wiki ligando `POST /v2/ativacoes`) e liberar a ONU de teste | ONU online + PPPoE | Cancelar a ativação pelo portal |
| 8 | Conferir que nada foi cobrado no Voalle e que a porta entrou no fechamento do portal | Contrato com valor zero (aprovado, se o Voalle exigir para a conexão funcionar); porta ativa no fechamento do mês | Speed corrige no Voalle |

Reversão geral: voltar os modos para `off`. Contratos criados continuam no banco do portal; os que não virarem instalação a Speed abandona pelo painel e cancela no Voalle.

## 7. Pendências deste fluxo

**Wiki / Voalle**
- Rota de **cancelar contrato não aprovado** (hoje a Speed cancela à mão no Voalle depois de abandonar no portal). Sem ela não há como limpar contrato órfão por API.
- `contrato.estado` que o Voalle mostra para contrato recém-criado e não aprovado (o portal assume `pendente_aprovacao`; confirmar o texto).
- Confirmar o mapeamento velocidade → serviço do Voalle (600, 700, 800, 1000), com **serviço de valor zero** (ou item zerado no contrato), e que `plano_nao_configurado` cobre os demais.
- O Voalle exige **contrato aprovado** para a conexão PPPoE autenticar? Se sim, a Wiki aprova na criação.
- Limite prático de contratos sob o mesmo CNPJ (ainda sem resposta).
- O que acontece com a conexão (login e senha) quando o contrato é cancelado.
- Configuração do Voalle (tipo de contrato "Integração" e campanha).

**Decisões do Juan**
1. ~~Gatilho de aprovação do contrato~~: **deixou de ser decisão de cobrança** (o contrato não tem valor). Só importa se o Voalle exigir contrato aprovado para a conexão autenticar; nesse caso a Wiki aprova já na criação (não há risco de cobrança). Pergunta à Wiki.
2. **Cobrança no fechamento do portal** (agora é a fonte da cobrança): mês cheio ou proporcional, na ativação e no cancelamento? O padrão implementado é **mês cheio nos dois** (o cancelado paga o mês do cancelamento e sai do seguinte).
3. **Prazo para abandonar** contrato sem instalação: hoje o alerta é aos 7 dias; ajustar se a operação for diferente.
