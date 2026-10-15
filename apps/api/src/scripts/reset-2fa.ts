import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { resetFor } from "../services/mfa.js";

/**
 * Recuperação do segundo fator pelo servidor, para quem perdeu o celular E os códigos de recuperação
 * (típico do administrador, que não pode redefinir a si mesmo pelo portal).
 *
 *   docker compose exec -T api node dist/scripts/reset-2fa.js admin@exemplo.com
 *
 * Fica na auditoria como `auth.2fa_redefinido`, sem usuário (feito por quem tem acesso ao servidor).
 */
const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Uso: node dist/scripts/reset-2fa.js <e-mail do usuário>");
  process.exit(1);
}

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL);
try {
  const [user] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email));
  if (!user) {
    console.error(`Nenhum usuário com o e-mail ${email}.`);
    process.exitCode = 1;
  } else {
    await resetFor(db, user.id, null, "servidor");
    console.log(`Segundo fator de ${user.name} (${email}) redefinido. Na próxima entrada ele configura de novo.`);
  }
} finally {
  await close();
}
