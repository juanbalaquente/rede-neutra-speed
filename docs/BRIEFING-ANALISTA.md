# Rede Neutra Speed: briefing do analista (Voalle, contratos e faturamento)

Atualizado em 7 de outubro de 2026. Este documento é autocontido: tudo o que você (e o Claude que te ajuda) precisa está aqui.

---

## 1. Seu escopo

Você cuida **somente do Voalle**: **contratos** e **faturamento**. Nada além disso.

**Fora do seu escopo** (não investigue, não opine, não altere): OLTCloud, Codemaps, rede de fibra, CTO, ONU, sinal, SpeedWiki, o código do portal, dashboards e indicadores. Se uma dúvida passar por algum desses assuntos, anote a pergunta no fim da entrega e siga em frente.

Você **investiga e documenta**. Você **não escreve código de integração** e **não altera nada no Voalle**. O que você descobrir volta em arquivo, e a equipe implementa no código.

---

## 2. Contexto mínimo do projeto

A Speed Fibra vai oferecer **rede neutra**: um provedor parceiro vende internet aos próprios clientes usando a fibra da Speed, e paga à Speed **por porta ativada**. O parceiro usa um portal web e nunca acessa o Voalle diretamente.

O que isso significa para o Voalle:

- O **parceiro é o cliente da Speed** (uma pessoa jurídica no Voalle).
- **Cada cliente final do parceiro vira um contrato no Voalle, no nome do parceiro** (o assinante final não é cadastrado no Voalle). O portal guarda o nome do assinante num campo próprio.
- O contrato é criado por **automação**, a partir de um pedido do portal. Essa automação precisa: criar o contrato, associar o plano, gerar o login PPPoE, preencher o ponto de acesso (concentrador) e devolver o número do contrato.
- O número do contrato é a chave do cliente em todos os sistemas, no padrão `CONTRATO-PRIMEIRONOME` (exemplo: `48233-MARCOS`).
- Inadimplência: o portal vai pedir **bloqueio e desbloqueio** de contratos.
- Cobrança: a Speed cobra do parceiro o valor por porta ativada. Referência de preço, plano de 600 Mega: a Speed recebe R$ 40,00 por porta (o parceiro revende por R$ 99,90 ao cliente final, o que não passa pelo Voalle).
- O piloto começa com **um parceiro**, mas o desenho vale para vários.

---

## 3. O que você usa

- **Documentação da API de terceiros do Voalle:** coleção do Postman "API's para Terceiros - ERPVoalle".
- **Banco de dados do Voalle, em modo leitura:** você receberá uma credencial própria, somente leitura. Consultas em SQL.
- **A tela do próprio Voalle**, para conferir o que a API ou a consulta devolvem.

Não precisa de mais nada.

---

## 4. Regras de trabalho (valem para você e para o Claude que te ajuda)

1. **Somente leitura.** Nenhuma criação, edição ou exclusão no Voalle, por tela, API ou SQL. Se achar que precisa testar uma escrita, pare e peça autorização antes.
2. **Credenciais.** Nunca cole senha ou token em chat com IA nem em arquivo de entrega.
3. **Dados de clientes.** Não coloque nome, CPF, CNPJ, telefone ou endereço reais nos arquivos de entrega. Anonimize (`CLIENTE-A`, `00.000.000/0000-00`).
4. **Diga quando não souber.** "Não consegui confirmar" é resposta válida. Chute apresentado como fato não é.
5. **Mostre a evidência.** Toda afirmação vem com a prova: a consulta SQL usada, o endpoint testado, o print da tela.
6. **Confira na tela do Voalle.** Antes de entregar um número ou uma regra, compare ao menos um exemplo real com o que a tela do Voalle mostra.

### Instruções para o Claude que está te ajudando

> Este é um projeto de produção de um provedor de internet. Você só pode ler dados e documentos. Nunca execute POST, PUT, PATCH ou DELETE contra o Voalle nem comandos de escrita no banco. O escopo é somente Voalle, contratos e faturamento: não investigue outros sistemas. Nunca invente nome de tabela, coluna ou endpoint: se não confirmou olhando o sistema real, diga que não confirmou. Ao reportar um resultado, informe a consulta ou chamada exata usada. Nunca inclua dados pessoais reais nos arquivos produzidos. Siga o formato de entrega de cada tarefa.

---

## 5. O que já se sabe do Voalle

Descobertas anteriores da equipe. **Verifique antes de confiar**, não tome como verdade.

- Pessoas: `erp.people`. O campo `tx_id` guarda CPF/CNPJ.
- Contratos: `erp.contracts`. O campo `status` usa, entre outros: `1` = Normal, `3` = Cortesia, `4` = Cancelado. `cancellation_date` sozinho **não** indica cancelamento confiável.
- Cada contrato tem **dois números**: o "N" (`contract_number`) e o "L" (o login PPPoE, em `authentication_contracts.user`). A linha de `authentication_contracts` é apagada quando o contrato é cancelado.
- Visão pronta que junta contrato e cliente: `erp.v_contract_clients`.
- Endpoints da API de terceiros que a Speed já usa: faturas por CPF/CNPJ (`gettitlesbytxid`), boletos por contrato (`getcontractbillets`), títulos em aberto por vencimento (`getopentitlesbyexpirationdate`), status do ponto de acesso (`getaccesspointstatusbycontract`), consulta paginada de contratos (`contract/getpaged`), desbloqueio por confiança (`contracts/unlock`), e o módulo de CRM (leads, negociações).
- **Aviso:** na tela de usuários do Voalle, o botão Salvar já falhou em persistir mudanças. Desconfie de qualquer "salvou" sem conferir depois.

---

## 6. Suas tarefas

Faça nesta ordem. **As tarefas 1 e 2 são as mais importantes:** elas decidem se a criação e o bloqueio de contratos serão automáticos ou manuais no MVP.

Classificação usada nas respostas: **existe por API** / **só pela tela** / **não existe** / **não consegui confirmar**.

### Tarefa 1: Criar contrato por API

**Pergunta:** o Voalle permite criar, por API, um contrato no nome de um cliente PJ existente, com plano, ponto de acesso e login PPPoE?

**O que fazer:**
1. Leia a coleção do Postman e procure endpoints de criação de contrato, de ponto de acesso e de autenticação (login PPPoE). Veja também o módulo de CRM (negociação que vira contrato).
2. Para cada endpoint candidato, descreva o que ele faz **sem executá-lo** se ele escrever.
3. Descubra, olhando a tela de cadastro de contrato e o banco (leitura), quais são os campos obrigatórios para criar um contrato.

**Entregue:**
- Classificação.
- Se existir: endpoint, método, campos obrigatórios e opcionais, exemplo de resposta (anonimizado).
- Campos necessários para: cliente, plano, ponto de acesso, login PPPoE.
- O login PPPoE é gerado pelo Voalle ou precisa ser informado? Qual o formato?
- O contrato nasce já ativo ou passa por aprovação? Qual passo o move para "Normal"?

### Tarefa 2: Bloqueio e desbloqueio

**Pergunta:** como bloquear e desbloquear um contrato por inadimplência, por API?

**O que fazer:** identifique no Voalle os tipos de bloqueio existentes (administrativo, financeiro, outros) e o "desbloqueio por confiança".

**Entregue, para cada operação** (bloquear, desbloquear, desbloqueio por confiança):
- Classificação.
- Endpoint, método e campos, se existir.
- O que muda no contrato (qual status ou campo) e como consultar o estado depois.
- O cliente perde o acesso na hora ou depois de algum processo? Quem executa essa mudança (o próprio Voalle ou outro sistema)?

### Tarefa 3: Cancelamento e estados do contrato

**Pergunta:** como o contrato muda de estado ao longo da vida e como cancelá-lo?

**Entregue:**
- Tabela com todos os valores de `contracts.status` e o que significam (com o texto exibido na tela).
- As transições possíveis (de qual status para qual).
- Cancelar ou encerrar contrato: classificação, endpoint se existir, e o que acontece com o login PPPoE, com títulos em aberto e com a cobrança do mês do cancelamento.
- Como consultar o status de um contrato por API ou SQL (e qual campo usar).

### Tarefa 4: Faturamento consolidado por parceiro

**Pergunta:** o parceiro terá dezenas ou centenas de contratos no mesmo CNPJ. Como o Voalle fatura isso?

**Entregue:**
- É possível gerar **uma fatura só** por parceiro, juntando todos os contratos? Como (configuração, agrupamento por pessoa, outra forma)?
- Existe limite prático de contratos sob o mesmo CNPJ (de tela, de fatura, de desempenho)?
- O que aparece na fatura: uma linha por contrato ou um total?
- Quando a fatura é gerada no mês (data fixa, vencimento configurável por cliente)?

### Tarefa 5: Preço por porta ativada

**Pergunta:** como configurar, no Voalle, a cobrança de "valor por porta ativada", com valor possivelmente diferente por parceiro?

**Entregue:**
- Como o preço do contrato é definido: pelo plano, pelo contrato, por tabela?
- É possível ter o **mesmo plano com valor diferente** para parceiros diferentes?
- Cobrança **proporcional** no mês de ativação e no de cancelamento: existe, como configura, como o valor sai?
- Um exemplo real (anonimizado) de contrato com plano de 600 Mega: de onde sai o valor mensal na tela e no banco.

### Tarefa 6: Consultar cobrança e pagamento de um parceiro

**Pergunta:** dado um CNPJ de parceiro, como obter, por API ou SQL, a posição de cobrança dele?

**Entregue:**
- Consulta (SQL e/ou endpoint) que devolve, para um CNPJ: contratos ativos, faturas do mês com valor total, vencimento, **situação do pagamento** (pago, em aberto, vencido) e valor em atraso.
- Como obter boleto e código Pix de uma fatura.
- Como detectar, de forma confiável, que um título foi pago (campo de baixa, data de pagamento).
- Conferência: pegue uma fatura real, compare com a tela e escreva "bateu" ou "diferença: ...".

### Tarefa 7: Ponto de acesso (concentrador) no contrato

**Pergunta:** o contrato precisa de um ponto de acesso (concentrador) que depende da OLT e da região. Onde isso é definido no Voalle?

**Entregue:**
- Lista dos pontos de acesso cadastrados no Voalle (nome e identificador).
- A regra de escolha. Se estiver escrita em algum lugar do Voalle, onde. Se for decisão manual de quem cadastra, diga e descreva o que a equipe faz hoje.
- Três exemplos reais (anonimizados) de contratos de regiões diferentes e o ponto de acesso de cada um.

---

## 7. Como entregar

Um arquivo por tarefa, nomeado `ENTREGA-01.md`, `ENTREGA-02.md` e assim por diante. Cada um com:

1. **Resposta curta no topo** (uma frase e a classificação, quando a tarefa pedir).
2. **Detalhamento** com a evidência.
3. **Consultas SQL** usadas, em arquivo `.sql` separado.
4. **O que não conseguiu confirmar**.
5. **Perguntas** que surgiram e fogem do seu escopo.

Entregue as tarefas 1 e 2 primeiro, antes de seguir para as outras: elas podem mudar o desenho de tudo o que vem depois.
