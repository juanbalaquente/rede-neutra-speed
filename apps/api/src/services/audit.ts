import type { Db } from "../db/client.js";
import { auditLog } from "../db/schema.js";

export interface AuditEntry {
  partnerId: string | null;
  userId: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string | null;
  data?: unknown;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    partnerId: entry.partnerId,
    userId: entry.userId,
    action: entry.action,
    entity: entry.entity ?? null,
    entityId: entry.entityId ?? null,
    ip: entry.ip ?? null,
    data: entry.data ?? null,
  });
}
