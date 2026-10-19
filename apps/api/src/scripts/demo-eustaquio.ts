import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { partners, users } from "../db/schema.js";
import { recordAudit } from "../services/audit.js";
import { mfaRequired } from "../services/mfa.js";

/**
 * Contas de demonstração em nome do Eustáquio, uma por perfil, para apresentar o portal.
 *
 *   docker compose exec -T api node dist/scripts/demo-eustaquio.js
 *
 * Cria o parceiro "Eustáquio Telecom" (siglas do piloto) e os usuários que faltam, com senha sorteada
 * aqui e mostrada uma vez só. Rodar de novo não mexe em quem já existe; para trocar a senha de todos,
 * passe `--novas-senhas`. Não existe perfil de técnico: em campo o técnico entra como atendente.
 * Fica na auditoria sem usuário (feito por quem tem acesso ao servidor).
 */
export const DEMO_PARTNER = { name: "Eustáquio Telecom", cnpj: "11222333000181", code: "EUS", allowedRegions: ["R1", "ITA", "FAT"] };

export const DEMO_USERS = [
  { email: "eustaquio.admin@demo.local", name: "Eustáquio (Admin Speed)", role: "admin_speed", perfil: "Administrador Speed" },
  { email: "eustaquio.supervisor@demo.local", name: "Eustáquio (Supervisor)", role: "supervisor", perfil: "Supervisor do parceiro (dono do provedor)" },
  { email: "eustaquio.atendente@demo.local", name: "Eustáquio (Atendente)", role: "atendente", perfil: "Atendente do parceiro" },
  { email: "eustaquio.tecnico@demo.local", name: "Eustáquio (Técnico)", role: "atendente", perfil: "Técnico de campo (perfil atendente, no celular)" },
] as const;

/** 12 caracteres sem os ambíguos (0/O, 1/l/I), sempre com letra e número. */
function generatePassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const chars = [letters[randomInt(letters.length)]!, digits[randomInt(digits.length)]!];
  while (chars.length < 12) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** Devolve cada conta com a senha nova, ou `null` quando a conta já existia e foi mantida. */
export async function createDemoAccounts(db: Db, opts: { resetPasswords: boolean }) {
  let [partner] = await db.select().from(partners).where(eq(partners.cnpj, DEMO_PARTNER.cnpj));
  if (!partner) {
    [partner] = await db.insert(partners).values(DEMO_PARTNER).returning();
    await recordAudit(db, { partnerId: partner!.id, userId: null, action: "parceiro.criado", entity: "partner", entityId: partner!.id, data: { origem: "servidor", demo: true } });
  }

  const accounts: { perfil: string; email: string; password: string | null }[] = [];
  for (const u of DEMO_USERS) {
    const partnerId = u.role === "admin_speed" ? null : partner!.id;
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email));
    if (existing && !opts.resetPasswords) {
      accounts.push({ perfil: u.perfil, email: u.email, password: null });
      continue;
    }
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    if (existing) {
      await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
      await recordAudit(db, { partnerId, userId: null, action: "usuario.senha_redefinida", entity: "user", entityId: existing.id, data: { origem: "servidor", demo: true } });
    } else {
      const [created] = await db.insert(users).values({ partnerId, email: u.email, name: u.name, role: u.role, passwordHash }).returning({ id: users.id });
      await recordAudit(db, { partnerId, userId: null, action: "usuario.criado", entity: "user", entityId: created!.id, data: { origem: "servidor", demo: true } });
    }
    accounts.push({ perfil: u.perfil, email: u.email, password });
  }
  return accounts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { db, close } = createDb(config.DATABASE_URL);
  try {
    const accounts = await createDemoAccounts(db, { resetPasswords: process.argv.includes("--novas-senhas") });
    const lines = accounts.map((a) => `${a.perfil}\n  e-mail: ${a.email}\n  senha:  ${a.password ?? "(já existia, não alterada)"}`);
    console.log(`\nContas do Eustáquio (anote agora, as senhas não aparecem de novo):\n\n${lines.join("\n\n")}\n`);
    if (mfaRequired(config, "supervisor")) {
      console.log("Admin e supervisor pedem o segundo fator no primeiro login: configure no celular antes da apresentação.");
    }
  } finally {
    await close();
  }
}
