import { eq, inArray } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { partners, portReservations } from "../db/schema.js";
import { createIntegrations } from "../integrations/index.js";

/**
 * Relatório SÓ DE LEITURA para escolher a CTO de uma nova venda de teste: as CTOs de uma PON (como a da ONU de bancada)
 * com vagas livres, idade do dado, quem as reservas do portal já ocupam e o que o parceiro ainda pode reservar.
 * Não grava nada: lê o mapa da região na Wiki (GET) e consulta o banco (SELECT). Usa a chave de leitura que o servidor já tem.
 *
 *   docker compose exec -T api node dist/scripts/rede-pon.js --codigo=JHV --regiao=R1 --pon=1/15
 *
 * O nome da CTO carrega a PON: CTO_05_P1_P15_R1 = slot 1, PON 15. A ONU só vincula a CTO da mesma PON.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const partnerCode = flag("codigo")?.toUpperCase();
const regiao = (flag("regiao") ?? "R1").toUpperCase();
const pon = flag("pon") ?? "1/15";
const [slot, ponNum] = pon.split("/");
if (!partnerCode || !/^\d+$/.test(slot ?? "") || !/^\d+$/.test(ponNum ?? "")) {
  console.error("Uso: node dist/scripts/rede-pon.js --codigo=<PARCEIRO> [--regiao=R1] [--pon=1/15]");
  process.exit(1);
}
const marker = `_P${slot}_P${ponNum}_`;

const config = loadConfig();
if (config.INTEGRATIONS_MODE !== "wiki") {
  console.error(`INTEGRATIONS_MODE=${config.INTEGRATIONS_MODE}: este relatório precisa de INTEGRATIONS_MODE=wiki (rede real).`);
  process.exit(1);
}
const { db, close } = createDb(config.DATABASE_URL);
try {
  const integrations = createIntegrations(config, () => {});
  const [partner] = await db.select().from(partners).where(eq(partners.code, partnerCode));
  if (!partner) throw new Error(`Nenhum parceiro com o código ${partnerCode}.`);
  if (!integrations.network.getRegionCtos) throw new Error("A integração não oferece o mapa por região.");
  const map = await integrations.network.getRegionCtos(regiao);
  if (!map) throw new Error(`A Wiki não conhece a sigla ${regiao}.`);

  const live = await db
    .select({ ctoId: portReservations.ctoId, partnerId: portReservations.partnerId, status: portReservations.status, contract: portReservations.contractNumber })
    .from(portReservations)
    .where(inArray(portReservations.status, ["ativa", "convertida"]));
  const mine = live.filter((r) => r.partnerId === partner.id);
  const liveAll = (id: string) => live.filter((r) => r.ctoId === id).length;
  const liveMine = (id: string) => mine.filter((r) => r.ctoId === id).length;

  const ctos = map.ctos.filter((c) => c.name.includes(marker)).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\nParceiro ${partner.name} (${partnerCode}) · ${partner.status === "bloqueado" ? "BLOQUEADO" : "ativo"}`);
  console.log(`  siglas liberadas: ${partner.allowedRegions.join(", ") || "(nenhuma: nada é oferecido)"}${partner.allowedRegions.includes(regiao) ? "" : `  ← ${regiao} NÃO está liberada`}`);
  console.log(`  limite de ocupação por CTO: ${partner.maxCtoOccupancyPct}% · reservas simultâneas: ${mine.filter((r) => r.status === "ativa").length}/${partner.maxActiveReservations} ativas`);
  console.log(`\nMapa ${map.regiao} lido na Wiki em ${map.atualizadoEm} · ${map.ctos.length} CTOs na sigla, ${ctos.length} na PON ${pon}\n`);

  if (!ctos.length) console.log(`Nenhuma CTO com "${marker}" no nome.`);
  const idade = (iso: string | null) => (iso ? `${Math.round((Date.now() - new Date(iso).getTime()) / 60_000)} min` : "sem data");
  for (const c of ctos) {
    const limiteParceiro = Math.floor((c.totalVagas * partner.maxCtoOccupancyPct) / 100);
    const livresPortal = c.vagasLivres - liveAll(c.ctoId);
    const velho = !c.updatedAt || Date.now() - new Date(c.updatedAt).getTime() > 60 * 60_000;
    const oferecida = c.confidence === "fontes_concordam" && !velho && livresPortal > 0 && liveMine(c.ctoId) < Math.max(limiteParceiro, 0);
    console.log(`${oferecida ? "✔" : "✖"} ${c.name}  (id ${c.ctoId})`);
    console.log(`    vagas: ${c.vagasLivres} livres de ${c.totalVagas} na rede · reservas vivas no portal: ${liveAll(c.ctoId)} (do ${partnerCode}: ${liveMine(c.ctoId)}) · livres para reservar: ${Math.max(livresPortal, 0)}`);
    console.log(`    limite do parceiro nessa CTO: ${limiteParceiro} vagas · dado: ${c.confidence}, lido há ${idade(c.updatedAt)}${velho ? "  ← VELHO (mais de 1 h)" : ""}`);
    if (c.motivos.length) console.log(`    motivos: ${c.motivos.join("; ")}`);
    if (c.location) console.log(`    posição: ${c.location.lat}, ${c.location.lng}`);
    const contracts = live.filter((r) => r.ctoId === c.ctoId && r.contract).map((r) => `${r.contract}(${r.status})`);
    if (contracts.length) console.log(`    contratos que ocupam vaga: ${contracts.join(", ")}`);
  }
  console.log("\n✔ = o portal oferece a vaga agora · ✖ = não oferece (cheia, no limite, dado velho ou 'conferir').");
} finally {
  await close();
}
