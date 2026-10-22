import { useCallback, useRef, useState } from "react";

const PREFIX = "rn-draft:";

function read<T extends Record<string, string>>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return initial;
    const saved = JSON.parse(raw) as Partial<T>;
    // Só aceita as chaves que o formulário conhece, com texto.
    const merged = { ...initial };
    for (const k of Object.keys(initial)) if (typeof saved[k] === "string") (merged as Record<string, string>)[k] = saved[k]!;
    return merged;
  } catch {
    return initial;
  }
}

/**
 * Campos de formulário que sobrevivem a recarregar a página ou perder a conexão (uso em campo):
 * cada mudança vai para o localStorage; `clear` apaga depois de salvar de verdade.
 * Se o navegador bloquear o armazenamento, funciona como estado comum.
 */
export function useDraft<T extends Record<string, string>>(key: string, initial: T): [T, (patch: Partial<T>) => void, () => void] {
  const first = useRef(initial);
  const [value, setValue] = useState<T>(() => read(key, first.current));

  const update = useCallback(
    (patch: Partial<T>) => {
      setValue((cur) => {
        const next = { ...cur, ...patch };
        try {
          localStorage.setItem(PREFIX + key, JSON.stringify(next));
        } catch {
          // Sem armazenamento: segue só em memória.
        }
        return next;
      });
    },
    [key],
  );

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // ignora
    }
  }, [key]);

  return [value, update, clear];
}
