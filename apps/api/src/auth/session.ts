import { jwtVerify, SignJWT } from "jose";

export type Role = "atendente" | "supervisor" | "admin_speed";

export interface SessionUser {
  id: string;
  partnerId: string | null;
  role: Role;
  name: string;
  /** Administrador Speed vendo o painel de um parceiro como supervisor, só para consulta. */
  verComo?: { partnerName: string } | null;
}

/** O que o cookie carrega além do usuário: o parceiro que o administrador está vendo e quando a sessão vence. */
export interface SessionToken extends SessionUser {
  verComoPid: string | null;
  exp: number;
}

export const SESSION_COOKIE = "rn_session";

/** `expires`: horas a partir de agora, ou o instante (em segundos) em que a sessão já vencia, para trocar de modo sem estender o login. */
export async function signSession(user: SessionUser, secret: string, expires: number | { at: number }, verComoPid: string | null = null): Promise<string> {
  return new SignJWT({ pid: user.partnerId, role: user.role, name: user.name, ...(verComoPid ? { vc: verComoPid } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(typeof expires === "number" ? `${expires}h` : expires.at)
    .sign(new TextEncoder().encode(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionToken | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      partnerId: (payload.pid as string | null) ?? null,
      role: payload.role as Role,
      name: String(payload.name ?? ""),
      verComoPid: typeof payload.vc === "string" ? payload.vc : null,
      exp: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}

// ── Desafio do segundo fator: entre a senha certa e o código ────────────────
const challengeKey = (secret: string) => new TextEncoder().encode(`mfa-challenge:${secret}`);

export async function signMfaChallenge(userId: string, secret: string): Promise<string> {
  return new SignJWT({ purpose: "mfa" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(challengeKey(secret));
}

/** Id do usuário se o desafio é válido e não expirou; null em qualquer outro caso. */
export async function verifyMfaChallenge(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, challengeKey(secret), { algorithms: ["HS256"] });
    return payload.purpose === "mfa" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
