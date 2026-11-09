import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { PHOTO_KINDS, photos, portReservations, type PhotoKind } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import type { PhotoStorage } from "../storage/photos.js";
import { recordAudit } from "./audit.js";

export const LINK_MAX_HOURS = 48;

export interface UploadInput {
  reservationId: string;
  kind: PhotoKind;
  bytes: Uint8Array;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  capturedAt?: Date | null;
}

/** Descobre o formato pelos primeiros bytes; o tipo que o cliente declara não vale. */
export function sniffImage(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** A foto vem de uma reserva do próprio parceiro (de outro parceiro ou inexistente: 404). */
async function ownReservation(db: Db, partnerId: string, id: string) {
  const [row] = await db
    .select()
    .from(portReservations)
    .where(and(eq(portReservations.id, id), eq(portReservations.partnerId, partnerId)));
  if (!row) throw new AppError(404, "reserva_nao_encontrada", "Reserva não encontrada.");
  return row;
}

export function isPhotoKind(v: string): v is PhotoKind {
  return (PHOTO_KINDS as readonly string[]).includes(v);
}

export async function uploadPhoto(
  db: Db,
  storage: PhotoStorage,
  user: SessionUser,
  input: UploadInput,
  opts: { maxBytes: number; ip?: string | null },
) {
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Só usuários de parceiro enviam fotos.");
  const reservation = await ownReservation(db, user.partnerId, input.reservationId);
  if (reservation.status !== "ativa" && reservation.status !== "convertida") {
    throw new AppError(409, "reserva_indisponivel", "Essa reserva não está mais aberta.");
  }
  if (input.bytes.length === 0) throw new AppError(400, "foto_vazia", "Arquivo vazio.");
  if (input.bytes.length > opts.maxBytes) {
    throw new AppError(422, "foto_grande_demais", `A foto passa de ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`);
  }
  const mime = sniffImage(input.bytes);
  if (!mime) throw new AppError(422, "formato_invalido", "Envie uma imagem JPEG, PNG ou WebP.");

  const id = randomUUID();
  // Chave só com dados do servidor: parceiro/reserva/uuid. Nada do nome do arquivo enviado.
  const storageKey = `${user.partnerId}/${reservation.id}/${id}.${EXT[mime]}`;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  await storage.put(storageKey, input.bytes);

  const [created] = await db
    .insert(photos)
    .values({
      id,
      partnerId: user.partnerId,
      userId: user.id,
      reservationId: reservation.id,
      contract: reservation.contractNumber,
      kind: input.kind,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      accuracyM: input.accuracyM ?? null,
      capturedAt: input.capturedAt ?? null,
      storageKey,
      mime,
      sizeBytes: input.bytes.length,
      sha256,
    })
    .returning();
  await recordAudit(db, {
    partnerId: user.partnerId,
    userId: user.id,
    action: "foto.enviada",
    entity: "photo",
    entityId: id,
    ip: opts.ip,
    data: { reservationId: reservation.id, kind: input.kind, sizeBytes: input.bytes.length, gps: input.lat != null && input.lng != null },
  });
  return created!;
}

/** Metadados públicos de uma foto (sem a chave de armazenamento). */
export const photoView = (p: typeof photos.$inferSelect) => ({
  id: p.id,
  reservationId: p.reservationId,
  contract: p.contract,
  kind: p.kind,
  lat: p.lat,
  lng: p.lng,
  accuracyM: p.accuracyM,
  capturedAt: p.capturedAt,
  createdAt: p.createdAt,
  sizeBytes: p.sizeBytes,
});

export async function listPhotos(db: Db, user: SessionUser, reservationId: string) {
  const scope = user.role === "admin_speed" ? eq(photos.reservationId, reservationId) : and(eq(photos.reservationId, reservationId), eq(photos.partnerId, user.partnerId!));
  return db.select().from(photos).where(scope).orderBy(desc(photos.createdAt));
}

/** A reserva já tem foto de medição? Exigida antes de pedir a ativação. */
export async function hasKind(db: Db, reservationId: string, kinds: PhotoKind[]): Promise<boolean> {
  const rows = await db.select({ id: photos.id }).from(photos).where(and(eq(photos.reservationId, reservationId), inArray(photos.kind, kinds))).limit(1);
  return rows.length > 0;
}

/** Foto visível ao usuário: do próprio parceiro, ou qualquer uma para a Speed. Senão 404. */
export async function ownPhoto(db: Db, user: SessionUser, id: string) {
  const scope = user.role === "admin_speed" ? eq(photos.id, id) : and(eq(photos.id, id), eq(photos.partnerId, user.partnerId!));
  const [row] = await db.select().from(photos).where(scope);
  if (!row) throw new AppError(404, "foto_nao_encontrada", "Foto não encontrada.");
  return row;
}

export async function readPhoto(storage: PhotoStorage, p: typeof photos.$inferSelect) {
  const bytes = await storage.get(p.storageKey);
  if (!bytes) throw new AppError(404, "foto_nao_encontrada", "Foto não encontrada.");
  return bytes;
}

// ── Link assinado (para a Infra ver a foto sem conta no portal) ──────────────

function linkKey(secret: string): Buffer {
  return createHash("sha256").update(`photo-link:${secret}`).digest();
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Token = base64url("<fotoId>.<expiraEmSegundos>") + "." + HMAC. Quem tem o link vê aquela foto até expirar, nada mais. */
export function signPhotoLink(photoId: string, expiresAt: Date, secret: string): string {
  const payload = b64(`${photoId}.${Math.floor(expiresAt.getTime() / 1000)}`);
  const sig = createHmac("sha256", linkKey(secret)).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** photoId do token se a assinatura vale e não expirou; null em qualquer outro caso (sem dizer por quê). */
export function verifyPhotoLink(token: string, secret: string, now = new Date()): string | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", linkKey(secret)).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [photoId, exp] = Buffer.from(payload, "base64url").toString().split(".");
  if (!photoId || !exp || Number(exp) * 1000 < now.getTime()) return null;
  return photoId;
}

export async function createPhotoLink(
  db: Db,
  user: SessionUser,
  photoId: string,
  opts: { hours: number; secret: string; baseUrl?: string; ip?: string | null; now?: Date },
) {
  const photo = await ownPhoto(db, user, photoId);
  const hours = Math.min(Math.max(opts.hours, 1), LINK_MAX_HOURS);
  const expiresAt = new Date((opts.now ?? new Date()).getTime() + hours * 3600_000);
  const path = `/api/photos/shared/${signPhotoLink(photo.id, expiresAt, opts.secret)}`;
  await recordAudit(db, {
    partnerId: photo.partnerId,
    userId: user.id,
    action: "foto.link_criado",
    entity: "photo",
    entityId: photo.id,
    ip: opts.ip,
    data: { expiresAt, hours },
  });
  return { path, url: opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, "")}${path}` : null, expiresAt };
}
