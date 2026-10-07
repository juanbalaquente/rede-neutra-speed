import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Say = (message: string, kind?: "ok" | "bad") => void;

const ToastContext = createContext<Say>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "bad"; show: boolean } | null>(null);
  const timer = useRef<number>(0);

  const say = useCallback<Say>((message, kind = "ok") => {
    window.clearTimeout(timer.current);
    setToast({ message, kind, show: true });
    timer.current = window.setTimeout(() => setToast((t) => (t ? { ...t, show: false } : t)), 4500);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={say}>
      {children}
      <div className={`toast ${toast?.kind === "bad" ? "bad" : ""} ${toast?.show ? "show" : ""}`} role="status" aria-live="polite">
        {toast?.message}
      </div>
    </ToastContext.Provider>
  );
}
