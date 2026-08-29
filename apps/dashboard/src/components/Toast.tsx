import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastTone = "neutral" | "healthy" | "critical";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = useCallback((message: string, tone: ToastTone = "neutral") => {
    const id = nextId++;
    setToasts((current) => [...current, { id, message, tone }]);
    const timer = window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      tone === "critical" ? 9000 : 5000,
    );
    timers.current.push(timer);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast tone-${toast.tone}`}>
            <span className="toast-mark" aria-hidden="true" />
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
            >
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
