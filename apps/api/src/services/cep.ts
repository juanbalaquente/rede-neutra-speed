/** Consulta de CEP (ViaCEP, serviço público). Só leva o CEP; nenhum dado de cliente sai do portal. */
export interface CepResult {
  cep: string;
  rua: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export type CepLookup = (cep: string) => Promise<CepResult | null>;

const cache = new Map<string, { at: number; value: CepResult | null }>();
const TTL_MS = 24 * 3600_000;

/** `null` quando o CEP não existe. Falha de rede ou resposta estranha lança erro (a tela deixa digitar à mão). */
export const viaCep: CepLookup = async (cep) => {
  const hit = cache.get(cep);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`viacep ${res.status}`);
  const j = (await res.json()) as { erro?: unknown; logradouro?: string; bairro?: string; localidade?: string; uf?: string };
  const value: CepResult | null = j.erro
    ? null
    : { cep, rua: j.logradouro ?? "", bairro: j.bairro ?? "", cidade: j.localidade ?? "", uf: (j.uf ?? "").toUpperCase() };
  cache.set(cep, { at: Date.now(), value });
  return value;
};
