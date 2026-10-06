export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Violação de unicidade no Postgres (postgres-js e PGlite expõem `code`). */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}
