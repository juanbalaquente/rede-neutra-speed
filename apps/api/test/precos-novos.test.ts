import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const folder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Roda o SQL da migration 0019 de novo, como se o banco ainda tivesse a tabela antiga. */
async function runPrecosNovos(client: PGlite) {
  const sql = await readFile(`${folder}/0019_precos_novos.sql`, "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) await client.exec(stmt);
}

describe("migration 0019: tabela de valores da Speed", () => {
  it("leva o banco antigo aos valores novos, tira o 700 da venda e audita só o que mudou", async () => {
    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: folder });
    await client.exec(`INSERT INTO plans (name, speed_mbps, speed_price_cents) VALUES
      ('600 Mega', 600, 4000), ('700 Mega', 700, 4400), ('800 Mega', 800, 4800), ('1 Giga', 1000, 5600)`);

    await runPrecosNovos(client);
    const plans = (await client.query<{ speed_mbps: number; speed_price_cents: number; active: boolean }>("SELECT speed_mbps, speed_price_cents, active FROM plans ORDER BY speed_mbps")).rows;
    expect(plans).toEqual([
      { speed_mbps: 600, speed_price_cents: 4000, active: true },
      { speed_mbps: 700, speed_price_cents: 4400, active: false },
      { speed_mbps: 800, speed_price_cents: 5000, active: true },
      { speed_mbps: 1000, speed_price_cents: 7000, active: true },
    ]);
    const audit = (await client.query<{ action: string; data: Record<string, unknown> }>("SELECT action, data FROM audit_log ORDER BY id")).rows;
    expect(audit.map((a) => [a.action, a.data.plano, a.data.before, a.data.after])).toEqual([
      ["plano.preco_speed", "800 Mega", 4800, 5000],
      ["plano.preco_speed", "1 Giga", 5600, 7000],
      ["plano.fora_da_venda", "700 Mega", undefined, undefined],
    ]);

    // Rodar de novo não muda nada nem duplica a auditoria.
    await runPrecosNovos(client);
    expect((await client.query("SELECT 1 FROM audit_log")).rows).toHaveLength(3);
  });

  it("migration 0020 grava o preço da Speed ao cliente final como referência, com auditoria", async () => {
    const client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: folder });
    await client.exec(`INSERT INTO plans (name, speed_mbps, speed_price_cents, active) VALUES
      ('600 Mega', 600, 4000, true), ('700 Mega', 700, 4400, false), ('800 Mega', 800, 5000, true), ('1 Giga', 1000, 7000, true)`);
    const sql = await readFile(`${folder}/0020_preco_referencia.sql`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").slice(1)) await client.exec(stmt);

    const plans = (await client.query<{ speed_mbps: number; reference_price_cents: number | null }>("SELECT speed_mbps, reference_price_cents FROM plans ORDER BY speed_mbps")).rows;
    expect(plans.map((p) => [p.speed_mbps, p.reference_price_cents])).toEqual([[600, 9990], [700, null], [800, 12990], [1000, 14990]]);
    const audit = (await client.query<{ action: string; data: Record<string, unknown> }>("SELECT action, data FROM audit_log ORDER BY id")).rows;
    expect(audit.map((a) => [a.action, a.data.plano, a.data.after])).toEqual([
      ["plano.preco_referencia", "600 Mega", 9990],
      ["plano.preco_referencia", "800 Mega", 12990],
      ["plano.preco_referencia", "1 Giga", 14990],
    ]);
  });
});
