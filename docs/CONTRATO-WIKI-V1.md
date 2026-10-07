# Contrato portal Rede Neutra ↔ SpeedWiki (v1)

API que a SpeedWiki expõe em `/proxy/redeneutra/v1/*` para o portal. Revisado em 7 out 2026 com as respostas do time da Wiki. O cliente do portal que consome este contrato é `apps/api/src/integrations/wiki.ts`; o formato inteiro vive só nele.

**Estado:** a Wiki ainda **não implementou** nada disto. O portal já está pronto do lado dele (`INTEGRATIONS_MODE=wiki`, com testes contra respostas simuladas). Divergências: comentar no PR ou registrar aqui.

Escopo da v1: **somente leitura**. Nenhuma rota escreve em Voalle, OLTCloud ou Codemaps.

## Princípios

1. **Versão no caminho.** Quebra de formato vira `/v2`, com as duas convivendo um tempo. Campo novo opcional não quebra: o portal ignora o que não conhece.
2. **Resposta fora do contrato é erro.** O portal valida cada resposta com schema. Campo obrigatório ausente ou com tipo errado vira falha explícita (o usuário vê "sistema indisponível"), nunca um palpite.
3. **A Wiki entrega o dado já tratado:** caixas gêmeas, nomes repetidos, sentinela -99.99 e cruzamento Codemaps × OLTCloud. O portal não lê tabelas da Wiki.
4. **Ausência de marcação de ocupada não é porta livre.** Porta sem confirmação é `desconhecida` e nunca é oferecida.
5. **Nulo é nulo.** `null` significa "a fonte não informou" e nunca vira zero.

## Autenticação e operação

- Header `X-RedeNeutra-Key`, uma chave para a integração, no modelo do `X-SpeedParceiros-Key`.
- O portal é o único chamador. O isolamento entre parceiros é feito **no portal**; a Wiki não sabe quem é o parceiro nesta versão.
- A chave só existe em variável de ambiente (`WIKI_API_KEY` no portal). Na Wiki, entra no arquivo de ambiente **e** no item `speedwiki-proxy-env` do Vaultwarden, senão o sincronizador a apaga.
- Rate limit (proposta da Wiki, aceita): `/viabilidade` 30/min e `/portas` 150/min, cada um com chave própria, por IP. O servidor do portal terá IP fixo. Estimativa do portal por consulta de atendente: 1 `/viabilidade`, até 5 `/portas` (snapshot) e 1 `/portas?fresh=true` na reserva.

## Rotas

### `GET /proxy/redeneutra/v1/viabilidade?endereco=<texto>&raio=<metros>`

```json
{
  "point": { "lat": -19.9193, "lng": -43.9385 },
  "ctos": [
    {
      "ctoId": "17342",
      "name": "CTO-EXEMPLO-01",
      "distanceM": 120,
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
- **`ctoId`:** **id do Codemaps** (o item de `nearbyaddress` traz `id` numérico), como string. A Wiki liga a caixa do OLTCloud por `external_id` (campo da caixa), não por nome. Na amostra de 24 itens (não representativa), `external_id` achou 18 e o nome achou 13; onde os dois acharam, apontaram a mesma caixa, e há caixas renomeadas no OLTCloud em que só o `external_id` liga. `null` é caso **raro**: só quando o item do Codemaps não traz id. A CTO continua na lista: o portal não oferece porta dela e registra a demanda.
- **`freePorts`:** contagem segundo o mapa (Codemaps, campo `avaliable`). Pode ser `null`. O portal trata `null` como "conferir".
- **`proximaAmbigua`:** `true` quando duas candidatas estão a menos de ~25 m uma da outra (valor a calibrar). Opcional; ausente vale `false`. O portal mostra o aviso "a CTO certa só se confirma em campo" e **nunca escolhe a mais próxima sozinho**. A confirmação definitiva é em campo, na ativação.

### `GET /proxy/redeneutra/v1/ctos/{ctoId}/portas[?fresh=true]`

```json
{
  "ctoId": "17342",
  "name": "CTO-EXEMPLO-01",
  "totalPorts": 16,
  "confidence": "fontes_concordam",
  "updatedAt": "2026-10-07T14:10:00-03:00",
  "motivos": [],
  "ports": [
    { "port": 1, "state": "ocupada" },
    { "port": 2, "state": "livre" },
    { "port": 3, "state": "desconhecida" }
  ]
}
```

- `state`: `livre` | `ocupada` | `desconhecida`.
- Em caixas gêmeas, `ports` é a **união** das duas (ocupada em qualquer uma conta como ocupada).
- **`confidence`:** `fontes_concordam` | `conferir`.
  - **`fontes_concordam` não é garantia.** Só diz que as fontes não se contradizem. A Wiki não distingue "livre de verdade" de "livre mas com ONU não vinculada". Por isso o portal nunca usa a palavra "garantida": a interface diz "livre segundo os sistemas da Speed, com confirmação final em campo".
  - **`conferir`:** a Wiki devolve quando uma regra determinística dispara: nome repetido sem coincidência única de coordenada; gêmea anexada com `totalPorts` diferente entre as duas caixas; Codemaps (`avaliable`) diferente das portas livres do OLTCloud; snapshot velho demais. O critério "muitas ONUs sem vínculo na PON" **não** é implementável hoje (só ~28% das caixas têm `pon_id`).
- **`updatedAt`** (obrigatório, ISO 8601 com fuso): quando a ocupação foi lida. **Idade máxima:** 15 min no normal; acima de 1 h a Wiki devolve `conferir`. O portal aplica o mesmo limite de 1 h como segunda barreira (e dado sem data conta como velho).
- **`motivos`** (opcional, lista de códigos): por que está em `conferir`, para a Speed saber o que checar. **Aparece só para a Speed**; o parceiro vê só "a Speed precisa conferir".
- **`?fresh=true`:** a Wiki consulta só aquela caixa (e a gêmea) direto no OLTCloud, sem varredura. O portal usa na **reserva**. A viabilidade usa o snapshot.
- **404:** "CTO sem caixa no OLTCloud ou inexistente". Existe CTO do Codemaps sem caixa no OLTCloud (6 de 24 na amostra: emendas, "DT" e CTOs provavelmente novas), e uma caixa renomeada ou recriada também pode deixar de ligar. **O portal trata todos esses casos como "conferir", não como "CTO sumiu"**, e guarda também o nome na reserva.

### `GET /proxy/redeneutra/v1/health`

```json
{ "ok": true }
```

Para o portal alertar quando a chave falhar. `401`/`403` aparece para o administrador Speed como "chave recusada pela Wiki"; o servidor do portal também registra no log a cada 5 min enquanto estiver fora.

## Como o portal aplica o contrato

Uma CTO só oferece portas se **todas** estas condições valem; senão sai como "conferir" e o parceiro não vê nenhuma porta dela:

1. `ctoId` não nulo (caso raro).
2. `/portas` não devolveu 404 (a CTO tem caixa no OLTCloud).
3. `confidence` é `fontes_concordam`.
4. `freePorts` não nulo e igual a `livres + desconhecidas` de `/portas` (segunda barreira do portal).
5. `updatedAt` com menos de 1 h.

Porta `desconhecida` nunca é oferecida, mesmo com a CTO ok. A reserva é chaveada por `ctoId` e exige uma consulta de viabilidade recente (24 h) do mesmo parceiro e endereço que tenha listado a CTO.

## Erros

| Status | O que o portal faz |
|---|---|
| 401 / 403 | erro de configuração: o usuário vê "sistema indisponível" e o administrador vê "chave recusada" |
| 404 em `/portas` | "conferir" |
| 422 | pedido inválido (ex.: Plus Code) |
| 429 | não repete em laço |
| 5xx / timeout (15 s) | "sistema indisponível" |

## Em aberto

- **Reservas invisíveis para a Speed (v1.1, depende de decisão do Juan).** A reserva vive só no banco do portal; o comercial da Speed não a enxerga e dois lados podem vender a mesma porta. Proposta da Wiki: o portal publica eventos (criada, cancelada, expirada, convertida) numa rota de **escrita** da Wiki, que mantém uma tabela espelho; a viabilidade interna subtrai as portas reservadas. Isso escreve no banco **da própria Wiki** (não nos sistemas de origem), mas muda o escopo "somente leitura". `/portas` continua devolvendo só a verdade da rede (se subtraísse as reservas do portal, o portal contaria em dobro). Condições do portal: os eventos saem de uma fila no banco do portal com reenvio até a Wiki confirmar, e cada evento traz o id da reserva, para receber o mesmo evento duas vezes não duplicar.
- **Cobertura real (pendente da Wiki):** medir quantas CTOs do Codemaps têm caixa no OLTCloud e como ficam as caixas nativas gêmeas (`external_id` e vínculo com a normal). A amostra de 24 itens sugere que parte relevante das CTOs vai sair como "conferir" (6 de 24 sem caixa), o que afeta a escolha das CTOs do piloto.
- **Regra de "ocupada" (resolvida em 7 out 2026, amostra de leitura da Wiki):** vale `status != "Livre"`. Das 121.427 portas: 113.625 Livre sem cliente; 7.795 Ocupada com `client_id` e `pppoe`; 6 Ocupada sem `client_id`/`pppoe`; 1 Ocupada com `client_id` sem `pppoe`; 0 Livre com cliente. Em toda caixa, `occupation.length == ports`. A regra por `client_id`/`pppoe` (`cto-off-monitor`) deixaria 7 portas ocupadas passarem como livres. O cliente direto do portal (modo `real`) mantém `status != "Livre"`.
- **Calibrar** a distância de `proximaAmbigua` (~25 m).
- Chamados de infraestrutura (abrir e consultar), média de sinal por CTO sem o sentinela -99.99 (trava de sinal) e webhooks de CTO caída ficam para a v1.1.
