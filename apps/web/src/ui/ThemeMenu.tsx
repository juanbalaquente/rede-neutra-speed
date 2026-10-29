import { useEffect, useRef, useState, type ReactElement } from "react";
import { DropIcon, MoonIcon, SunIcon } from "./Icons";
import { THEMES, type Theme } from "./theme";

export const THEME_ICON: Record<Theme, () => ReactElement> = { light: SunIcon, dark: MoonIcon, blue: DropIcon };

/** Seletor de tema no cabeçalho: claro, escuro ou azul Speed. */
export function ThemeMenu({ theme, onChoose }: { theme: Theme; onChoose: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const Current = THEME_ICON[theme];
  return (
    <div className="tmenu" ref={ref}>
      <button className="ibtn" onClick={() => setOpen((o) => !o)} aria-label="Escolher tema" aria-expanded={open} aria-haspopup="menu">
        <Current />
      </button>
      {open && (
        <div className="tmenu-pop card" role="menu" aria-label="Tema">
          {THEMES.map((t) => {
            const Ico = THEME_ICON[t.id];
            return (
              <button
                key={t.id}
                role="menuitemradio"
                aria-checked={t.id === theme}
                className={t.id === theme ? "on" : undefined}
                onClick={() => {
                  onChoose(t.id);
                  setOpen(false);
                }}
              >
                <i className={`sw sw-${t.id}`} aria-hidden="true" />
                <span>{t.label}</span>
                <Ico />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
