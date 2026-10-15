import { useEffect, useRef, useState } from "react";

export interface Notice {
  id: string;
  tone: "warn" | "bad" | "info";
  text: string;
  onOpen: () => void;
}

/** Sino de avisos: o que precisa de atenção agora, calculado dos dados que o portal já tem. */
export function Bell({ notices }: { notices: Notice[] }) {
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

  return (
    <div className="bell" ref={ref}>
      <button className="ibtn" onClick={() => setOpen((o) => !o)} aria-label={notices.length ? `${notices.length} avisos` : "Sem avisos"} aria-expanded={open}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {notices.length > 0 && <span className="bell-n">{notices.length}</span>}
      </button>
      {open && (
        <div className="bell-pop card" role="dialog" aria-label="Avisos">
          <div className="ch"><h3>Avisos</h3></div>
          {notices.length === 0 ? (
            <p className="empty">Nada pedindo atenção agora.</p>
          ) : (
            <ul>
              {notices.map((n) => (
                <li key={n.id}>
                  <button onClick={() => { setOpen(false); n.onOpen(); }}>
                    <i className={`dot ${n.tone}`} aria-hidden="true" />
                    <span>{n.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
