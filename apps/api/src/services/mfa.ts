import { and, eq, isNull } from "drizzle-orm";
import QRCode from "qrcode";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { recoveryCodes, users } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { recordAudit } from "./audit.js";
import { decryptSecret, encryptSecret, hashRecovery, newRecoveryCodes, newSecret, otpauthUrl, verifyTotp } from "./totp.js";

type UserRow = typeof users.$inferSelect;

const secretKey = (config: Config) => config.TOTP_KEY ?? config.SESSION_SECRET;

/** O segundo fator é obrigatório para este usuário? Só supervisor e administrador Speed, e só com MFA_REQUIRED ligado. */
export function mfaRequired(config: Config, role: UserRow["role"]): boolean {
  const on = config.MFA_REQUIRED ? config.MFA_REQUIRED === "true" : config.NODE_ENV === "production";
  return on && role !== "atendente";
}

export function mfaState(config: Config, user: UserRow) {
  const required = mfaRequired(config, user.role);
  return { enabled: user.totpEnabled, required, setupRequired: required && !user.totpEnabled };
}

/** Gera (ou troca) o segredo pendente e devolve o QR. Só vale depois de confirmado com um código. */
export async function startSetup(db: Db, config: Config, user: UserRow) {
  if (user.totpEnabled) throw new AppError(409, "segundo_fator_ativo", "O segundo fator já está ativo. Peça à Speed para redefinir.");
  const secret = newSecret();
  await db.update(users).set({ totpSecretEnc: encryptSecret(secret, secretKey(config)), totpLastStep: null }).where(eq(users.id, user.id));
  const url = otpauthUrl(secret, user.email);
  return { secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
}

/** Confirma o primeiro código, liga o segundo fator e devolve os códigos de recuperação (só aparecem agora). */
export async function enable(db: Db, config: Config, user: UserRow, code: string, now = new Date(), ip?: string | null) {
  if (user.totpEnabled) throw new AppError(409, "segundo_fator_ativo", "O segundo fator já está ativo.");
  if (!user.totpSecretEnc) throw new AppError(409, "sem_configuracao", "Comece a configuração pelo QR code.");
  const step = verifyTotp(decryptSecret(user.totpSecretEnc, secretKey(config)), code, now);
  if (step === null) throw new AppError(422, "codigo_invalido", "Código incorreto. Confira a hora do celular e tente de novo.");
  const codes = newRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ totpEnabled: true, totpLastStep: step }).where(eq(users.id, user.id));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
    await tx.insert(recoveryCodes).values(codes.map((c) => ({ userId: user.id, codeHash: hashRecovery(c) })));
  });
  await recordAudit(db, { partnerId: user.partnerId, userId: user.id, action: "auth.2fa_ativado", entity: "user", entityId: user.id, ip });
  return codes;
}

/**
 * Confere o segundo passo do login: código do app ou um código de recuperação (uso único).
 * Falha sempre com a mesma mensagem, sem dizer qual dos dois estava errado.
 */
export async function verifyLogin(
  db: Db,
  config: Config,
  user: UserRow,
  input: { code?: string; recoveryCode?: string },
  now = new Date(),
  ip?: string | null,
): Promise<boolean> {
  if (!user.totpEnabled || !user.totpSecretEnc) return false;
  if (input.code) {
    const step = verifyTotp(decryptSecret(user.totpSecretEnc, secretKey(config)), input.code, now, user.totpLastStep);
    if (step === null) return false;
    // Só avança se ninguém usou o mesmo intervalo entre a leitura e agora.
    const moved = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, user.id), user.totpLastStep === null ? isNull(users.totpLastStep) : eq(users.totpLastStep, user.totpLastStep)))
      .returning({ id: users.id });
    return moved.length > 0;
  }
  if (input.recoveryCode) {
    const used = await db
      .update(recoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, hashRecovery(input.recoveryCode)), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id });
    if (used.length === 0) return false;
    const left = await db.select({ id: recoveryCodes.id }).from(recoveryCodes).where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt)));
    await recordAudit(db, { partnerId: user.partnerId, userId: user.id, action: "auth.2fa_codigo_recuperacao", entity: "user", entityId: user.id, ip, data: { restantes: left.length } });
    return true;
  }
  return false;
}

/** Administrador Speed redefine o segundo fator de alguém (celular perdido): na próxima entrada, ele configura de novo. */
export async function resetFor(db: Db, targetId: string, byUserId: string | null, ip?: string | null) {
  const [target] = await db.select().from(users).where(eq(users.id, targetId));
  if (!target) throw new AppError(404, "usuario_nao_encontrado", "Usuário não encontrado.");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ totpSecretEnc: null, totpEnabled: false, totpLastStep: null }).where(eq(users.id, targetId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, targetId));
  });
  await recordAudit(db, { partnerId: target.partnerId, userId: byUserId, action: "auth.2fa_redefinido", entity: "user", entityId: targetId, ip });
  return target;
}
