// Gentle, non-blocking problem reports.
//
// `PoseSource.info.warning` ("카메라가 어두워요", "조금 뒤로 가 볼까요?") surfaces
// here. The rule from the pose contract applies to the UI too: never fail
// silently — "the game stopped responding" is the worst failure mode there is.
import { useCallback, useRef, useState } from 'react';

export type ToastTone = 'info' | 'warn' | 'success';

export interface ToastItem {
  id: number;
  textKo: string;
  tone: ToastTone;
}

export function useToasts(): {
  toasts: ToastItem[];
  push: (textKo: string, tone?: ToastTone, ms?: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((textKo: string, tone: ToastTone = 'info', ms = 3200) => {
    const id = nextId.current++;
    setToasts((t) => [...t.filter((x) => x.textKo !== textKo).slice(-2), { id, textKo, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  return { toasts, push };
}

export function ToastHost({ toasts }: { toasts: ToastItem[] }): React.ReactElement {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone} pop-in`}>
          {t.textKo}
        </div>
      ))}
    </div>
  );
}
