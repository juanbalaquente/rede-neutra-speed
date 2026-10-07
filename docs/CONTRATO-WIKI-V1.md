# Contrato portal Rede Neutra ↔ SpeedWiki (v1)

API que a SpeedWiki expõe em `/proxy/redeneutra/v1/*` para o portal. Revisado em 7 out 2026 com as respostas do time da Wiki e as decisões do Juan sobre o piloto. O cliente do portal que consome este contrato é `apps/api/src/integrations/wiki.ts`; o formato inteiro vive só nele.

**Estado:** a Wiki ainda **não implementou** nada disto. O portal já está pronto do lado dele (`INTEGRATIONS_MODE=wiki`, com testes contra respostas simuladas). Divergências: comentar no PR ou registrar aqui. Itens marcados **[PROPOSTA]** são do portal e a Wiki ainda precisa confirmar.

Escopo da v1: **somente leitura**. Nenhuma rota escreve em Voalle, OLTCloud ou Codemaps.

## Decisões do Juan (7 out 2026)

1. **Reserva por VAGA na CTO.** O número da porta não importa.
2. Qualquer saída de splitter pode ir para cliente.
3. A operação usa só Codemaps e OLTCloud; as caixas do Voalle ficam fora da conta. As caixas "nativas" do OLTCloud são splitters importados do Voalle (descrição "SMARTISP"), legado não mantido: **as propostas anteriores sobre gêmeas foram descartadas**.
4. CTO sem caixa no OLTCloud = "conferir" no piloto.
5. **Área do piloto:** OLTs Backbone Central, Itacolomi e Fátima, identificadas pelas siglas **R1**, **ITA** e **FAT** no nome da CTO. Objetivo futuro: a rede toda da SpeedNet, liberando por sigla.
6. Publicação de reservas na v1.1 como princípio, **sem construir agora** (ver "Em aberto").

## Princípios

1. **Versão no caminho.** Quebra de formato vira `/v2`, com as duas convivendo um tempo. Campo novo opcional não quebra: o portal ignora o que não conhece.
2. **Resposta fora do contrato é erro.** O portal valida cada resposta com schema. Campo obrigatório ausente ou com tipo errado vira falha explícita (o usuário vê "sistema indisponível"), nunca um palpite.
3. **A Wiki entrega o dado já tratado.** O portal não lê tabelas da Wiki.
4. **Ausência de informação não é vaga livre.** Dado fraco, velho ou sem caixa vira `conferir`.
5. **Nulo é nulo.** `null` significa "a fonte não informou" e nunca vira zero.

## Modelo de vagas

- **Base:** saídas de splitter livres no diagrama do Codemaps (`availableEqps` = `avaliable` do `nearbyaddress`).
- **Desconto:** se o OLTCloud tem mais clientes vinculados à caixa do que clientes desenhados, a diferença é descontada das vagas (motivo informativo `oltcloud_mais_clientes_que_desenho`, não bloqueia).
- **Sem caixa no OLTCloud:** `conferir` (a Wiki devolve 404 em `/vagas`; o portal trata como `sem_caixa_oltcloud`).
- **Dado com mais de 1 h:** `conferir` (`snapshot_antigo`).
- **Saíram do catálogo:** `gemea_total_diferente`, `gemea_nao_resolvida`, `gemea_numeracao_conflitante`, `fontes_divergentes`.
- **Risco que continua:** cliente instalado que não está desenhado nem vinculado é **invisível às duas fontes**. Validar 3 a 5 CTOs em campo (incluindo ao menos uma da FAT) antes de abrir o piloto.
- **Números do piloto (leitura da Wiki):** 880 CTOs (R1 434, ITA 335, FAT 111); 825 com pelo menos 1 vaga; 4.142 vagas; 82 sem caixa (74 com vaga) vão para `conferir`, restando cerca de 750 vendáveis. Desconto do OLTCloud: 43 vagas. R1 tem 15% sem caixa; ITA e FAT, 2 a 6%. FAT tem só 19 clientes vinculados para 111 CTOs (área nova ou cadastro atrasado). Validação das siglas pela OLT das ONUs vinculadas: R1 = Backbone Central (97% de 382), ITA = Itacolomi (99% de 563), FAT = Fátima (16 de 19, amostra pequena); nenhuma CTO casa com mais de uma sigla.

## Autenticação e operação

- Header `X-RedeNeutra-Key`, uma chave para a integração, no modelo do `X-SpeedParceiros-Key`.
- O portal é o único chamador. O isolamento entre parceiros é feito **no portal**; a Wiki não sabe quem é o parceiro nesta versão.
- A chave só existe em variável de ambiente (`WIKI_API_KEY` no portal). Na Wiki, entra no arquivo de ambiente **e** no item `speedwiki-proxy-env` do Vaultwarden, senão o sincronizador a apaga.
- Rate limit (aceito): `/viabilidade` 30/min e `/vagas` 150/min, cada um com chave própria, por IP. O servidor do portal terá IP fixo. Estimativa por consulta de atendente: 1 `/viabilidade`, até 5 `/vagas` (snapshot) e 1 `/vagas?fresh=true` na reserva.

## Rotas

### `GET /proxy/redeneutra/v1/viabilidade?endereco=<texto>&raio=<metros>`

```json
{
  "point": { "lat": -19.9193, "lng": -43.9385 },
  "ctos": [
    {
      "ctoId": "17342",
      "name": "CTO_01_ITA_EXEMPLO",
      "distanceM": 120,
      "regiao": "ITA",
      "freePorts": 3,
      "usagePct": 81,
      "location": { "lat": -19.9191, "lng": -43.9386 },
      "proximaAmbigua": false
    }
  ]
}
```

- **Raio:** o portal pede 300 m (padrão). A Wiki aceita até 1.000 m e devolve **todas** as candidatas do raio, da mais próxima à mais distante.
- `point` é `null` se o endereço não geocodificar. Plus Code: `422` com `plus_code_not_supported` (o portal já recusa antes de chamar).
- **`ctoId`:** **id do Codemaps** (o item de `nearbyaddress` traz `id` numérico), como string. A Wiki liga a caixa do OLTCloud por `external_id`, não por nome. `null` é caso **raro** (item sem id): a CTO aparece, mas não vende.
- **`regiao`:** sigla do nome da CTO (R1, ITA, FAT...), ou `null` se o nome não segue o padrão. A regra de extração é da Wiki. **CTO com `regiao` fora da lista do parceiro, ou `null`, não é oferecida ao parceiro.**
- **`freePorts`:** vagas livres segundo o mapa (campo `avaliable` do Codemaps; o nome `freePorts` é herança, o significado é "vagas"). Pode ser `null`; o portal trata `null` como `conferir`.
- **`proximaAmbigua`:** `true` quando duas candidatas estão a menos de ~25 m uma da outra (valor a calibrar). Opcional; ausente vale `false`. O portal mostra o aviso "a CTO certa só se confirma em campo" e **nunca escolhe a mais próxima sozinho**.

### `GET /proxy/redeneutra/v1/ctos/{ctoId}/vagas[?fresh=true]`

Substitui o antigo `/portas`. **Sem lista de portas.**

```json
{
  "ctoId": "17342",
  "name": "CTO_01_ITA_EXEMPLO",
  "regiao": "ITA",
  "vagasLivres": 4,
  "totalVagas": 16,
  "confidence": "fontes_concordam",
  "motivos": [],
  "updatedAt": "2026-10-07T14:10:00-03:00"
}
```

- **`vagasLivres`:** conforme o "Modelo de vagas" acima. **Não** desconta as reservas do portal (a Wiki não as conhece; o portal as desconta sozinho).
- **`totalVagas`** (obrigatório) **[PROPOSTA]:** total de saídas de splitter da CTO no diagrama do Codemaps. O portal precisa dele para o limite de ocupação por parceiro (50% das vagas da CTO).
- **`confidence`:** `fontes_concordam` | `conferir`. `fontes_concordam` **não é garantia**: só diz que as fontes não se contradizem. A interface diz "vaga livre segundo os sistemas da Speed, com confirmação final em campo".
- **`updatedAt`** (obrigatório, ISO 8601 com fuso): quando a leitura foi feita. Idade máxima: 15 min no normal; acima de 1 h a Wiki devolve `conferir` (`snapshot_antigo`). O portal aplica o mesmo limite como segunda barreira, e dado sem data conta como velho.
- **`motivos`** (opcional, lista de códigos): por que está em `conferir`, ou motivo informativo (que não bloqueia). **Só a Speed vê**; o parceiro vê apenas "a Speed precisa conferir". Catálogo: `sem_caixa_oltcloud` (usado pelo portal no 404), `snapshot_antigo`, `nome_repetido`, `oltcloud_mais_clientes_que_desenho` (informativo). Código desconhecido é mostrado como veio.
- **`?fresh=true`:** a Wiki consulta só aquela caixa direto no OLTCloud, sem varredura. O portal usa na **reserva**. A viabilidade usa o snapshot.
- **404:** "CTO sem caixa no OLTCloud ou inexistente". Existe CTO do Codemaps sem caixa (cobertura: 78% na rede toda, 90 a 93% no recorte do piloto); caixa renomeada ou recriada também pode deixar de ligar. **O portal trata todos como `conferir`, não como "CTO sumiu"**, e guarda também o nome na reserva.

### `GET /proxy/redeneutra/v1/health`

```json
{ "ok": true }
```

Para o portal alertar quando a chave falhar. `401`/`403` aparece para o administrador Speed como "chave recusada pela Wiki"; o servidor do portal também registra no log a cada 5 min enquanto estiver fora.

## Como o portal aplica o contrato

**Área.** O administrador Speed define, por parceiro, a lista de siglas liberadas (piloto: `R1`, `ITA`, `FAT`). Lista vazia = nenhuma CTO é oferecida (liberação explícita). A consulta fora da área é registrada como demanda (`fora_da_area`) e o parceiro vê que o endereço está fora da área do contrato. A área é verificada de novo na reserva, no servidor, com a sigla da leitura fresca.

**Vagas oferecidas.** Uma CTO só oferece vagas se **todas** estas condições valem; senão sai como `conferir` e o parceiro não vê vaga dela:

1. `ctoId` não nulo (caso raro).
2. `/vagas` não devolveu 404 (a CTO tem caixa no OLTCloud).
3. `confidence` é `fontes_concordam`.
4. `freePorts` do mapa não é nulo e `vagasLivres` não passa dele (a leitura pode ter menos vagas que o mapa, por causa do desconto do OLTCloud, nunca mais).
5. `updatedAt` com menos de 1 h.

**Reserva.** A trava `(cto_id, porta)` virou **contagem**: reservas vivas da CTO (todos os parceiros) + 1 ≤ `vagasLivres`, sob lock por CTO (duas reservas disputando a última vaga entram uma de cada vez), mantendo o limite de **50% de `totalVagas` por parceiro**. Exige uma consulta de viabilidade recente (24 h) do mesmo parceiro e endereço que tenha listado a CTO, e leitura com `?fresh=true`.

## Erros

| Status | O que o portal faz |
|---|---|
| 401 / 403 | erro de configuração: o usuário vê "sistema indisponível" e o administrador vê "chave recusada" |
| 404 em `/vagas` | `conferir` |
| 422 | pedido inválido (ex.: Plus Code) |
| 429 | não repete em laço |
| 5xx / timeout (15 s) | "sistema indisponível" |

## Em aberto

- **Reservas invisíveis para a Speed (v1.1, princípio decidido, não construído).** A reserva vive só no banco do portal; o comercial da Speed não a enxerga e dois lados podem vender a mesma vaga. Proposta: o portal publica eventos (criada, cancelada, expirada, convertida) numa rota de **escrita** da Wiki, que mantém uma tabela espelho; a viabilidade interna subtrai as reservas. Isso escreve no banco **da própria Wiki** (não nos sistemas de origem), mas muda o escopo "somente leitura". `/vagas` continua devolvendo só a verdade da rede (senão o portal contaria em dobro). Condições do portal: os eventos saem de uma fila no banco do portal com reenvio até a Wiki confirmar, e cada evento traz o id da reserva, para receber o mesmo evento duas vezes não duplicar.
- **Reserva `convertida`:** o portal conta reservas `ativa` **e** `convertida` contra as vagas. Quando o contrato existir e a Wiki/Codemaps passarem a mostrar o cliente desenhado, a mesma vaga seria contada duas vezes. Hoje nada gera `convertida`; revisar junto com a criação de contrato.
- **Limite de 50% por parceiro:** hoje conta só as reservas vivas do parceiro na CTO; clientes dele já ativados (fora do portal) não entram na conta até existir esse vínculo.
- **`totalVagas` e a regra de extração da sigla:** a Wiki confirma o campo e documenta a regra (qual parte do nome é a sigla).
- **Calibrar** a distância de `proximaAmbigua` (~25 m).
- **FAT:** só 19 clientes vinculados para 111 CTOs. Pode ser área nova ou cadastro atrasado; validar em campo.
- **Relatório no portal:** `GET /admin/cto-conferir` (e a tela "CTOs para conferir", só administrador Speed) lista as CTOs em `conferir` mais consultadas, com CSV (`id_codemaps`, `nome`, …) para cruzar com a lista da Wiki.
- **Fora da v1:** chamados de infraestrutura (abrir e consultar), média de sinal por CTO sem o sentinela -99.99 (trava de sinal) e webhooks de CTO caída.
