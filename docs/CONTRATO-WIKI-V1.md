# Contrato proposto: portal Rede Neutra ↔ SpeedWiki (v1)

Proposta do **portal** para a API que a SpeedWiki vai expor em `/proxy/redeneutra/v1/*`. Nada aqui existe na Wiki ainda: é o formato que o cliente do portal (`apps/api/src/integrations/wiki.ts`) já espera e valida. Se a Wiki preferir outro formato, **o ajuste é só naquele arquivo**; peço que a divergência seja registrada neste documento.

Escopo desta versão: **somente leitura**. Nenhuma rota escreve em Voalle, OLTCloud ou Codemaps.

## Princípios

1. **Versão no caminho.** Mudança que quebra o formato vira `/v2`, com as duas convivendo um tempo. Campo novo opcional não quebra: o portal ignora campos que não conhece.
2. **Resposta fora do contrato é erro.** O portal valida cada resposta. O que não bate vira falha explícita (502 para o usuário), nunca um palpite.
3. **A Wiki entrega o dado já tratado.** Caixas gêmeas, nomes repetidos, sentinela -99.99 e cruzamento Codemaps × OLTCloud ficam do lado da Wiki. O portal não lê tabelas da Wiki.
4. **Ausência de marcação não é "livre".** Porta sem confirmação é `desconhecida`, e o portal nunca a oferece.

## Autenticação

- Header `X-RedeNeutra-Key: <chave>`, no modelo do `X-SpeedParceiros-Key`.
- Uma chave por integração (o portal é o único chamador). O isolamento entre parceiros é feito **no portal**; a Wiki não sabe quem é o parceiro nesta versão.
- A chave fica só no ambiente do servidor do portal (`WIKI_API_KEY`). Na Wiki, precisa entrar também no item `speedwiki-proxy-env` do Vaultwarden (senão o sincronizador a apaga).
- Rate limit: o portal chama a partir de um IP próprio. Estimativa inicial: uma viabilidade por consulta de atendente e uma leitura de portas por CTO candidata (até 5 por consulta) mais uma na reserva.

## Rotas

### `GET /proxy/redeneutra/v1/viabilidade?endereco=<texto>&raio=<metros>`

CTOs próximas do endereço, ordenadas da mais próxima para a mais distante.

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
      "location": { "lat": -19.9191, "lng": -43.9386 }
    }
  ]
}
```

- `point` é `null` se o endereço não geocodificar. Plus Code: `422` com `plus_code_not_supported`, como na rota de parceiros (o portal já recusa antes de chamar).
- **`ctoId`** é o id estável da caixa (id do OLTCloud ou par de ids; a Wiki decide, desde que seja estável e único). Nunca o nome.
- `freePorts` é a contagem **segundo o mapa (Codemaps)**. O portal a cruza com a lista de portas abaixo (ver "Cruzamento").
- `raio` é do portal (hoje 300 m). **Pergunta aberta:** qual critério único de raio? Ver "Perguntas".

### `GET /proxy/redeneutra/v1/ctos/{ctoId}/portas`

```json
{
  "ctoId": "17342",
  "name": "CTO-EXEMPLO-01",
  "totalPorts": 16,
  "confidence": "confirmada",
  "ports": [
    { "port": 1, "state": "ocupada" },
    { "port": 2, "state": "livre" },
    { "port": 3, "state": "desconhecida" }
  ]
}
```

- `state`: `livre` | `ocupada` | `desconhecida`.
- `confidence`: `confirmada` | `conferir`. A Wiki devolve `conferir` quando sabe que o dado é fraco: fontes divergentes, caixa gêmea com clientes divididos, ONUs sem vínculo com a caixa, nome repetido. Com `conferir`, o portal **não oferece nenhuma porta** da CTO e mostra "a Speed precisa conferir".
- Com caixas gêmeas, `ports` deve refletir a **soma** das duas caixas (porta ocupada em qualquer uma conta como ocupada) ou a Wiki devolve `conferir`.
- CTO inexistente: `404`.

## Cruzamento de fontes (lado do portal)

O portal compara `freePorts` de `/viabilidade` (Codemaps) com a quantidade de portas `livre` de `/portas` (OLTCloud). Se divergirem, a CTO sai como "conferir". Ficam na Wiki as regras de tratamento; o portal só aplica esse teste final, como segunda barreira.

## Erros

| Status | Significado para o portal |
|---|---|
| 401 / 403 | chave inválida: erro de configuração, 502 para o usuário e alerta |
| 404 em `/portas` | CTO não encontrada (vira `null`) |
| 422 | pedido inválido (ex.: Plus Code) |
| 429 | limite atingido: o portal não repete em laço |
| 5xx / timeout (15 s) | sistema de origem indisponível, 502 para o usuário |

## O que fica para depois

Chamados de infraestrutura (abrir e consultar), status de contrato, média de sinal por CTO (trava de sinal, sem o sentinela -99.99), webhooks de CTO caída e escrita (contrato, autorizar ONU). Cada um ganha seção aqui quando a Wiki responder as perguntas abaixo.

## Perguntas para o time da Wiki

1. **O que é o `ctoId`?** id da caixa do OLTCloud, id do Codemaps, ou um id próprio da Wiki que resolve gêmeas?
2. **Raio:** 300 m (portal), 1 km (rota de parceiros) ou 150 m (URA)? Qual critério para a CTO mais próxima errada?
3. **Latência:** o `box/list` leva ~40 s. A Wiki pode servir `/portas` de cache atualizado em segundo plano? Qual a idade máxima do dado, e ela pode vir em um campo `updatedAt`?
4. **Como a Wiki sabe que uma CTO é `conferir`?** Quais critérios já existem hoje (gêmeas, ONU sem vínculo, nomes repetidos)?
5. **Reservas do portal são invisíveis para a Speed.** A Wiki consegue expor ao comercial da Speed as portas reservadas, ou o portal precisa publicar as reservas por uma rota/webhook?
6. **Rate limit** por `${ip}:${rota}`: o volume do portal cabe no padrão?
