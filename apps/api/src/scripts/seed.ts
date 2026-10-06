import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { partners, plans, users } from "../db/schema.js";

/** Planos da tabela sugerida no planejamento (valor fixo por plano). */
export const DEFAULT_PLANS = [
  { name: "600 Mega", speedMbps: 600, speedPriceCents: 4000 },
  { name: "700 Mega", speedMbps: 700, speedPriceCents: 4400 },
  { name: "800 Mega", speedMbps: 800, speedPriceCents: 4800 },
  { name: "1 Giga", speedMbps: 1000, speedPriceCents: 5600 },
];

export async function seed(db: Db, opts: { adminEmail: string; adminPassword: string; demo: boolean }) {
  for (const p of DEFAULT_PLANS) {
    await db.insert(plans).values(p).onConflictDoNothing({ target: plans.name });
  }
  const [existingAdmin] = await db.select().from(users).where(eq(users.email, opts.adminEmail));
  if (!existingAdmin) {
    await db.insert(users).values({
      email: opts.adminEmail,
      name: "Administrador Speed",
      role: "admin_speed",
      passwordHash: await hashPassword(opts.adminPassword),
    });
  }
  if (!opts.demo) return;

  const [partner] = await db
    .insert(partners)
    .values({ name: "Parceiro Demonstração", cnpj: "00000000000191" })
    .onConflictDoNothing({ target: partners.cnpj })
    .returning();
  if (!partner) return;
  const demoPassword = await hashPassword("demo12345a");
  await db.insert(users).values([
    { partnerId: partner.id, email: "supervisor@demo.local", name: "Supervisor Demo", role: "supervisor", passwordHash: demoPassword },
    { partnerId: partner.id, email: "atendente@demo.local", name: "Atendente Demo", role: "atendente", passwordHash: demoPassword },
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@speed.local";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword && config.NODE_ENV === "production") throw new Error("Defina SEED_ADMIN_PASSWORD");
  const { db, close } = createDb(config.DATABASE_URL);
  await seed(db, {
    adminEmail,
    adminPassword: adminPassword ?? "admin12345a",
    demo: config.NODE_ENV !== "production",
  });
  console.log(`Seed ok. Admin: ${adminEmail}`);
  await close();
}
