import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Onde ficam os arquivos das fotos. O resto do portal só conhece esta interface: trocar o
 * disco local por S3/MinIO é implementar estas duas funções. As chaves são geradas no servidor
 * (nunca vêm do cliente) e o arquivo nunca é servido como estático: só pela API, com checagem.
 */
export interface PhotoStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** null = não existe. */
  get(key: string): Promise<Uint8Array | null>;
}

export class LocalPhotoStorage implements PhotoStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** Garante que a chave fica dentro da pasta de fotos, mesmo que um dia venha de fora. */
  private path(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error("chave de foto inválida");
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

/** Para testes. */
export class MemoryPhotoStorage implements PhotoStorage {
  readonly files = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.files.set(key, bytes);
  }

  async get(key: string) {
    return this.files.get(key) ?? null;
  }
}
