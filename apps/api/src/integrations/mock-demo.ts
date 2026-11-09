import { createHash } from "node:crypto";
import type { MockCto } from "./mock.js";

/**
 * Rede de demonstração (MOCK_NETWORK=demo): CTOs fictícias em grade, por sigla, para apresentar o portal
 * com mapa cheio. Nenhum dado real. R2 existe de propósito fora do piloto: endereço com "Barreiro" cai lá
 * e vira "fora da área".
 */
interface DemoRegion {
  sigla: string;
  center: { lat: number; lng: number };
  cols: number;
  rows: number;
  /** Prefixo do id da caixa (o id real é numérico e não tem relação com o nome). */
  idBase: number;
}

const REGIONS: DemoRegion[] = [
  { sigla: "R1", center: { lat: -19.9193, lng: -43.9385 }, cols: 5, rows: 4, idBase: 24100 },
  { sigla: "ITA", center: { lat: -19.9335, lng: -43.9512 }, cols: 4, rows: 4, idBase: 35200 },
  { sigla: "FAT", center: { lat: -19.9058, lng: -43.9248 }, cols: 3, rows: 3, idBase: 11300 },
  { sigla: "R2", center: { lat: -19.9762, lng: -44.0128 }, cols: 2, rows: 2, idBase: 52100 },
];

/** Uns 110 m entre caixas: o raio de 300 m da viabilidade acha de 4 a 8. */
const STEP = 0.001;

/** Ocupação variada e estável: algumas cheias, a maioria com vaga, poucas quase vazias. */
const OCCUPANCY = [9, 4, 12, 16, 6, 10, 3, 13, 7, 11, 5, 14, 8, 2, 12, 9, 15, 6, 10, 4];

function buildCtos(): MockCto[] {
  const ctos: MockCto[] = [];
  for (const r of REGIONS) {
    let n = 0;
    for (let row = 0; row < r.rows; row++) {
      for (let col = 0; col < r.cols; col++) {
        n++;
        const total = n % 6 === 0 ? 8 : 16;
        const occ = Math.min(total, OCCUPANCY[(n + r.idBase) % OCCUPANCY.length]!);
        const cto: MockCto = {
          id: String(r.idBase + n),
          name: `CTO_${String(n).padStart(2, "0")}_P${(n % 4) + 1}_${r.sigla}`,
          lat: Number((r.center.lat + (row - (r.rows - 1) / 2) * STEP + ((n * 37) % 11) * 0.00002).toFixed(6)),
          lng: Number((r.center.lng + (col - (r.cols - 1) / 2) * STEP + ((n * 53) % 13) * 0.00002).toFixed(6)),
          totalPorts: total,
          occupied: Array.from({ length: occ }, (_, i) => i + 1),
          regiao: r.sigla,
        };
        // Uma caixa por sigla do piloto que a Speed precisa conferir, para a tela de conferência ter o que mostrar.
        if (n === 7 && r.sigla !== "R2") {
          cto.confidence = "conferir";
          cto.motivos = [r.sigla === "R1" ? "oltcloud_mais_clientes_que_desenho" : "sem_caixa_oltcloud"];
        }
        ctos.push(cto);
      }
    }
  }
  return ctos;
}

export const DEMO_CTOS: MockCto[] = buildCtos();

export const DEMO_REGIONS = REGIONS.map((r) => r.sigla);

function hash(text: string): number {
  return createHash("sha1").update(text.trim().toLowerCase()).digest().readUInt32BE(0);
}

/**
 * "Geocodificação" da demonstração: o mesmo endereço cai sempre no mesmo ponto. Bairro conhecido no texto
 * escolhe a sigla (Itacolomi, Fátima, Centro, Barreiro); qualquer outro endereço cai numa das três do piloto.
 */
export function demoGeocode(address: string): { lat: number; lng: number } {
  const text = address.toLowerCase();
  const h = hash(address);
  const pick = /barreiro/.test(text)
    ? "R2"
    : /itacolomi/.test(text)
      ? "ITA"
      : /f[aá]tima/.test(text)
        ? "FAT"
        : /centro|funcion[aá]rios|savassi/.test(text)
          ? "R1"
          : (["R1", "ITA", "FAT"] as const)[h % 3]!;
  const r = REGIONS.find((x) => x.sigla === pick)!;
  // Dentro da grade da sigla, com um deslocamento que depende do endereço.
  const dLat = (((h >>> 4) % 1000) / 1000 - 0.5) * (r.rows - 1) * STEP;
  const dLng = (((h >>> 14) % 1000) / 1000 - 0.5) * (r.cols - 1) * STEP;
  return { lat: Number((r.center.lat + dLat).toFixed(6)), lng: Number((r.center.lng + dLng).toFixed(6)) };
}
