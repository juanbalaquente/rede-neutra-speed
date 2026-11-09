import { useCallback, useState } from "react";

const KEY = "rn-theme";
export type Theme = "light" | "dark" | "blue";

export const THEMES: { id: Theme; label: string }[] = [
  { id: "light", label: "Claro" },
  { id: "dark", label: "Escuro" },
  { id: "blue", label: "Azul Speed" },
];

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "blue" ? v : null;
  } catch {
    return null;
  }
}

/** Claro, escuro ou azul Speed: segue o sistema (claro/escuro) até o usuário escolher; a escolha fica salva neste navegador. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? systemTheme());
  const choose = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* sem armazenamento: vale só nesta sessão */
    }
    setTheme(next);
  }, []);
  return { theme, choose };
}
