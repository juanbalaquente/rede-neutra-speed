import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/** TOTP (RFC 6238) com SHA-1, 6 dígitos e intervalo de 30 s: o que Google Authenticator, Microsoft Authenticator e Vaultwarden esperam. */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new Error("base32 inválido");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 20 bytes aleatórios (160 bits), em base32. */
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepOf = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS);

/**
 * Confere o código contra o intervalo atual e o vizinho de cada lado (relógio do celular
 * levemente fora). Devolve o intervalo que bateu, ou null. `lastStep`: um intervalo já usado
 * (ou anterior) nunca é aceito de novo, então o mesmo código não vale duas vezes.
 */
export function verifyTotp(secretB32: string, code: string, now: Date, lastStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = stepOf(now);
  for (const step of [current, current - 1, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = "Rede Neutra"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ── Cifra do segredo no banco (AES-256-GCM) ──────────────────────────────────

const key = (k: string) => createHash("sha256").update(`totp:${k}`).digest();

export function encryptSecret(secretB32: string, k: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(k), iv);
  const enc = Buffer.concat([cipher.update(secretB32, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored: string, k: string): string {
  const [iv, tag, enc] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !enc) throw new Error("segredo TOTP corrompido");
  const decipher = createDecipheriv("aes-256-gcm", key(k), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ── Códigos de recuperação ───────────────────────────────────────────────────

/** 10 códigos `xxxxx-xxxxx` (50 bits cada). Alfabeto sem letras ambíguas (0/o, 1/l). */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecovery = (code: string) => code.trim().toLowerCase().replace(/\s+/g, "");
export const hashRecovery = (code: string) => createHash("sha256").update(normalizeRecovery(code)).digest("hex");
