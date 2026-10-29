import { and, eq, inArray, notInArray } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { customerOperations, partners, portReservations } from "../db/schema.js";
import { OPERATION_FINAL } from "../integrations/types.js";
import { recordAudit } from "../services/audit.js";

/**
 * Marca no portal, e só no portal, clientes que já foram cancelados fora dele (no Voalle e no OLTCloud,
 * pela Wiki ou pela equipe). Não chama a Wiki: um novo cancelamento tentaria encerrar contrato e remover
 * ONU que já não existem. A vaga volta e o cliente sai da lista de ONUs; fica como histórico em Instalações.
 *
 *   docker compose exec -T api node dist/scripts/marcar-cancelado.js --codigo=JHV 33720 33721 33726
 *   docker compose exec -T api node dist/scripts/marcar-cancelado.js --codigo=JHV 33720 33721 33726 --apply
 *
 * Sem --apply só mostra o que faria. --data=AAAA-MM-DD é o dia do cancelamento (o fechamento do mês cobra a
 * porta até ele); padrão hoje. --motivo="..." vai para a reserva e para a auditoria (`cliente.cancelado_fora_do_portal`).
 */

export type Outcome = "marcado" | "seria_marcado" | "ja_cancelado" | "nao_encontrado" | "nao_instalado";

export async function markCancelledOutside(
  db: Db,
  opts: { partnerCode: string; contracts: string[]; apply: boolean; at: Date; reason: string },
): Promise<{ contract: string; outcome: Outcome; openOperations: number }[]> {
  const [partner] = await db.select({ id: partners.id }).from(partners).where(eq(partners.code, opts.partnerCode.toUpperCase()));
  if (!partner) throw new Error(`Nenhum parceiro com o código ${opts.partnerCode}.`);
  const out: { contract: string; outcome: Outcome; openOperations: number }[] = [];
  for (const contract of opts.contracts) {
    const rows = await db
      .select()
      .from(portReservations)
      .where(and(eq(portReservations.partnerId, partner.id), eq(portReservations.contractNumber, contract)));
    const row = rows.find((r) => r.status === "convertida") ?? rows[0];
    if (!row) { out.push({ contract, outcome: "nao_encontrado", openOperations: 0 }); continue; }
    const open = await db
      .select({ id: customerOperations.id })
      .from(customerOperations)
      .where(and(eq(customerOperations.reservationId, row.id), notInArray(customerOperations.state, [...OPERATION_FINAL])));
    if (row.customerStatus === "cancelado" || row.status === "cancelada") { out.push({ contract, outcome: "ja_cancelado", openOperations: open.length }); continue; }
    if (row.status !== "convertida") { out.push({ contract, outcome: "nao_instalado", openOperations: open.length }); continue; }
    if (!opts.apply) { out.push({ contract, outcome: "seria_marcado", openOperations: open.length }); continue; }
    await db.transaction(async (tx) => {
      await tx
        .update(portReservations)
        .set({ status: "cancelada", customerStatus: "cancelado", cancelReason: opts.reason, cancelledBy: null, cancelledAt: opts.at, updatedAt: new Date() })
        .where(and(eq(portReservations.id, row.id), eq(portReservations.status, "convertida")));
      // Operação que ficou aberta (a Wiki concluiu e o portal nunca soube) não deve mais ser consultada.
      if (open.length) {
        await tx
          .update(customerOperations)
          .set({ state: "concluida", wikiNote: "Concluída fora do portal (marcada pelo servidor).", updatedAt: new Date() })
          .where(inArray(customerOperations.id, open.map((o) => o.id)));
      }
      await recordAudit(tx as Db, {
        partnerId: partner.id,
        userId: null,
        action: "cliente.cancelado_fora_do_portal",
        entity: "port_reservation",
        entityId: row.id,
        data: { contrato: contract, motivo: opts.reason, cancelado_em: opts.at.toISOString(), operacoes_fechadas: open.length, origem: "servidor" },
      });
    });
    out.push({ contract, outcome: "marcado", openOperations: open.length });
  }
  return out;
}

const LABEL: Record<Outcome, string> = {
  marcado: "marcado como cancelado",
  seria_marcado: "seria marcado como cancelado (rode com --apply)",
  ja_cancelado: "já estava cancelado no portal, nada a fazer",
  nao_encontrado: "não existe no portal para esse parceiro",
  nao_instalado: "não é cliente instalado (reserva sem conversão), nada a fazer",
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const contracts = args.filter((a) => !a.startsWith("--"));
  const partnerCode = flag("codigo");
  const day = flag("data");
  const at = day ? new Date(`${day}T12:00:00-03:00`) : new Date();
  if (!partnerCode || !contracts.length || Number.isNaN(at.getTime())) {
    console.error("Uso: node dist/scripts/marcar-cancelado.js --codigo=<PARCEIRO> <contrato> [contrato...] [--data=AAAA-MM-DD] [--motivo=\"...\"] [--apply]");
    process.exit(1);
  }
  const config = loadConfig();
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const result = await markCancelledOutside(db, { partnerCode, contracts, apply: args.includes("--apply"), at, reason: flag("motivo") ?? "Cancelado fora do portal" });
    for (const r of result) console.log(`${r.contract}: ${LABEL[r.outcome]}${r.openOperations ? ` (${r.openOperations} operação(ões) aberta(s)${r.outcome === "marcado" ? " fechada(s)" : ""})` : ""}`);
  } finally {
    await close();
  }
}
