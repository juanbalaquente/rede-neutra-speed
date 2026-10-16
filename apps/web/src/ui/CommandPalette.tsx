import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PinIcon, SearchIcon } from "./Icons";

export interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

/** Ctrl K: ir para uma tela, trocar o tema, ou digitar um endereço para consultar a viabilidade. */
export function CommandPalette({
  open,
  onClose,
  commands,
  onAddress,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  onAddress: ((address: string) => void) | null;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    input.current?.focus();
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = commands.filter((c) => !q || c.title.toLowerCase().includes(q));
    const list: Command[] = [];
    // Texto que parece endereço (rua e número) vira a primeira opção.
    if (onAddress && query.trim().length >= 8) {
      list.push({
        id: "addr",
        group: "Viabilidade",
        title: `Consultar “${query.trim()}”`,
        hint: "Enter",
        icon: <PinIcon />,
        run: () => onAddress(query.trim()),
      });
    }
    return [...list, ...found];
  }, [query, commands, onAddress]);

  if (!open) return null;

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      const item = items[cursor];
      if (item) {
        onClose();
        item.run();
      }
    }
  }

  let lastGroup = "";
  return (
    <div className="cmdk" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKey} role="dialog" aria-label="Busca de comandos">
      <div className="cbox">
        <div className="cin">
          <SearchIcon size={16} />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            placeholder="Digite um endereço ou o nome de uma tela"
            aria-label="Buscar"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="clist">
          {items.length === 0 && <p className="muted" style={{ padding: "14px 10px", margin: 0 }}>Nada encontrado.</p>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? <div className="cgrp">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header}
                <button
                  className={`cit ${i === cursor ? "on" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => {
                    onClose();
                    item.run();
                  }}
                >
                  <span className="ic">{item.icon}</span>
                  <span style={{ minWidth: 0 }}>{item.title}</span>
                  <span className="r">{item.hint}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="cfoot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navegar</span>
          <span><kbd>Enter</kbd> abrir</span>
        </div>
      </div>
    </div>
  );
}

