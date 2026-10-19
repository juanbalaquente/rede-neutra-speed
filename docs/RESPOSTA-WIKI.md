# Resposta da SpeedWiki ao `PEDIDO-WIKI.md`

> **Atualização (16 out 2026):** a decisão sobre senha PPPoE mudou depois desta resposta: não haverá rota de senha. Ver a seção B do contrato v3.


Escrito em 16 out 2026 pela equipe da Wiki. Responde ao pedido item a item e acrescenta o que mudou depois das respostas do suporte da Voalle (15 e 16 out). Itens marcados **[DECIDIR - Juan]** dependem de decisão interna da Speed.

## 1. Falta uma peça no pedido: a criação do contrato no Voalle

O pedido não tem nenhuma rota para **criar o contrato**, e é dele que nasce o login `<contrato>-<CÓDIGO>` usado como chave em todo o resto. Do lado da Wiki, isso já está construído e **desligado** (`deploy/proxy/voalleContratos.js` e `scripts/voalle-rn-contrato.mjs` no repo da Wiki):

- `contracts/create` cria o contrato no nome do parceiro. **A conexão PPPoE nasce junto** (confirmado pela Voalle), com o login igual ao número do contrato.
- A Wiki troca o login para `<contrato>-<CÓDIGO>`, gera a senha (nunca devolvida, nunca em log), define o ponto de acesso pela sigla da CTO (R1 = 2, ITA = 3, FAT = 11) e o concentrador acompanha.
- **Endereço:** o Voalle sobrescreve o endereço principal do cliente a cada contrato. Por isso a Wiki manda sempre o endereço que **já está no cadastro do parceiro** e grava o endereço real do assinante **só na conexão**, pela API de mapas da Voalle, com a coordenada.
- Falta só a configuração no Voalle (tipo de contrato com "Integração" ligada e campanha "E-commerce - Integração"), já em andamento. **Corrigido em 18 out:** a chave "Integração" não é necessária; o que falta é vincular os 4 planos da Speed (serviços 00229, 00232, 00233 e 00332) a um tipo de contrato no Voalle.

**Proposta de rota** (escrita, `X-RedeNeutra-Write-Key`, mesmas regras de idempotência e operação do v3):

### `POST /proxy/redeneutra/v3/contratos`
```json
{
  "idempotencyKey": "uuid",
  "reservaId": "id da reserva no portal (vai na observação do contrato)",
  "parceiroCnpj": "00000000000000",
  "plano": { "velocidadeMbps": 600, "valorMensal": 40.00 },
  "ctoId": "24109",
  "endereco": { "cep": "34505000", "rua": "Rua ...", "numero": "10", "complemento": "", "bairro": "...", "cidade": "Sabará", "uf": "MG" },
  "location": { "lat": -19.89, "lng": -43.86 }
}
```
- `X-RedeNeutra-Partner` obrigatório. O parceiro precisa estar cadastrado no Voalle com esse CNPJ e endereço completo (senão `422 parceiro_sem_cadastro`).
- `plano.velocidadeMbps` vira o serviço do Voalle por uma tabela na Wiki. Velocidade sem serviço configurado: `422 plano_nao_configurado`.
- Nenhum nome de assinante. O endereço e a coordenada são da instalação e só vão para a conexão.
- Resposta `202 {"operacaoId": "..."}`. `GET /v3/operacoes/{id}` com `tipo: "contrato"` e as etapas `contrato_criado`, `conexao_ajustada` e `endereco_gravado`. Ao concluir, a operação traz `resultado: {"contrato": "33431", "login": "33431-JHV"}`.
- **O contrato nasce sem aprovação, logo não fatura.** Proposta: a Wiki aprova o contrato quando a **ativação da ONU (v2) chega a `online`**. Assim a cobrança começa na porta ativada, como no modelo comercial. Reserva cancelada antes da ativação: o contrato não aprovado é cancelado. **[DECIDIR - Juan]** confirmar esse gatilho e a proporcionalidade do primeiro mês.

Se a proposta servir, vocês ajustam e incluem no contrato v3. A Wiki implementa a rota em cima do que já existe.

## 2. Bloqueio e desbloqueio (Prioridade 4.2): a resposta já existe

- A API do Voalle **não tem bloqueio administrativo**. Tem **suspensão** (`Contract/Suspend`, status "Suspenso", com justificativa).
- O `contracts/unlock` **não desfaz bloqueio administrativo** (serve para outro caso), então não serve para desbloquear.
- O pedido diz que o bloqueio "mantém a porta e a cobrança". **Suspensão provavelmente interrompe a cobrança.** **[DECIDIR - Juan]**:
  - (a) inadimplência vira suspensão via API, aceitando que a cobrança para; ou
  - (b) bloqueio administrativo manual: a operação vira `aguardando_equipe` e abre card no Kanban (o fallback que vocês já previram).

## 3. Senha PPPoE (Prioridade 5): não depende do analista

A senha fica em `authentication_contracts.password` no Voalle (a Wiki lê esse banco). No fluxo novo, é **a própria Wiki que gera a senha** ao criar o contrato. A rota `GET /v3/clientes/{login}/senha-pppoe` pode sair sem esperar o analista, com `no-store`, sem log e com o registro de quem pediu.

## 4. Cancelamento (Prioridade 4.3)

- **Etapa `contrato_encerrado`:** não há endpoint de cancelar contrato na API para Terceiros. Já perguntamos à Voalle. Até a resposta, essa etapa pode virar `aguardando_equipe` (card no Kanban) e as outras duas (OLTCloud e Codemaps) seguem automáticas.
- **`409 fatura_em_aberto`:** quem paga é o **parceiro**, um CNPJ com todos os contratos, não o assinante. Consultar "fatura em aberto do cliente" não faz sentido nesse modelo. **[DECIDIR - Juan]** se a regra vira "parceiro com fatura vencida não cancela" ou se sai.

## 5. Respostas à Prioridade 1 e às perguntas de dados

- **PPPoE no snapshot do NE40:** entra a seguir. É o próximo item da Wiki.
- **Incidente por CTO:** dá para fazer a partir do `cto-off-monitor`. Entra junto.
- **VLAN:** a ONU tem mais de uma VLAN (ex.: `1000` e `29`), e a Wiki ainda não sabe com segurança qual é a de gerência. Fica `null` até confirmarmos com a Infra qual delas é a de serviço. Não bloqueia.
- **CTO `52108` (`CTO_12_P2_P4_R1`):** não tem caixa no OLTCloud, então `/vagas` responde 404 e ela fica fora do mapa por sigla. Esperado, é "conferir". O diagrama do Codemaps mostra as 8 saídas ocupadas, e a lista do Codemaps diz 1 livre. As fontes divergem.
- **CTO `24109`:** fica na Rua Carvalho de Brito, bairro Nações Unidas, Sabará. O geocoder do Codemaps erra o ponto nessa rua (cai a 370 a 840 m), então para validar a reserva usem a CTO pelo mapa por sigla, não por endereço.
- **Achado:** a viabilidade do Codemaps devolve **no máximo 10 CTOs**, mesmo com raio de 1 km. Em área densa, uma CTO mais distante pode não aparecer na lista.
- **Achar a ONU:** sim, por casamento exato do alias ou do login PPPoE. Mandar também a serial é bem-vindo como reforço.

## 6. Chamados (Prioridade 2)

A proposta (Kanban externo com `external_ref` = `chamadoId`, `source: "redeneutra"`) serve à Wiki. Faltam decisões internas:

- **[DECIDIR - Juan]** qual board (Infra?) e quais colunas valem como `em_atendimento` e `resolvido`.
- **Fotos:** a Wiki deve **baixar e guardar** na criação do chamado, já que o link expira em 48 h. **[DECIDIR - Juan]** confirmar.
- **Trava de sinal:** ok, a Wiki não abre card próprio na decisão `prosseguir`.
- **SLA:** ok, a Wiki só guarda e mostra.

## 7. Ordem na Wiki

1. PPPoE no snapshot + incidente por CTO (leitura).
2. Senha PPPoE sob demanda.
3. Criação de contrato (assim que o Voalle estiver configurado), testada primeiro num contrato da Speed.
4. Chamados (depois das decisões do item 6).
5. Reinício, ativação (v2), bloqueio e cancelamento.

Toda escrita continua desligada até a validação do Juan num contrato ou ONU de teste da Speed.
