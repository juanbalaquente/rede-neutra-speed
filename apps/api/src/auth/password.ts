import bcrypt from "bcryptjs";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Regra mínima de senha forte: 10+ caracteres, letra e número. */
export function isStrongPassword(plain: string): boolean {
  return plain.length >= 10 && /[a-zA-Z]/.test(plain) && /\d/.test(plain);
}
