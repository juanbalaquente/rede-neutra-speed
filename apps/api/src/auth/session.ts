import { jwtVerify, SignJWT } from "jose";

export type Role = "atendente" | "supervisor" | "admin_speed";

export interface SessionUser {
  id: string;
  partnerId: string | null;
  role: Role;
  name: string;
}

export const SESSION_COOKIE = "rn_session";

export async function signSession(user: SessionUser, secret: string, hours: number): Promise<string> {
  return new SignJWT({ pid: user.partnerId, role: user.role, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${hours}h`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      partnerId: (payload.pid as string | null) ?? null,
      role: payload.role as Role,
      name: String(payload.name ?? ""),
    };
  } catch {
    return null;
  }
}
