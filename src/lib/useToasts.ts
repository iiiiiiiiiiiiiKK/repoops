import { useCallback, useEffect, useRef, useState } from 'react';

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  message: string;
}

let seq = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<number[]>([]);

  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++seq;
    setToasts((all) => [...all, { id, kind, message }]);
    const timer = window.setTimeout(() => {
      setToasts((all) => all.filter((t) => t.id !== id));
    }, kind === 'error' ? 7000 : 3800);
    timers.current.push(timer);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return { toasts, push, dismiss };
}
