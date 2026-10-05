import { useEffect, useState } from 'react';

export function TextField({ label, value, onSave }: { label: string; value: string; onSave(value: string): void }) {
  const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);
  return <label>{label}<input value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => { onSave(draft); setDraft(value); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}
export function NumberField({ label, value, onSave, min, max, step = .1 }: { label: string; value: number; onSave(value: number): void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    if (next !== value) onSave(next);
    setDraft(String(next));
  };
  return <label>{label}<input type="text" inputMode="decimal" value={draft} min={min} max={max} step={step} onFocus={() => setFocused(true)} onChange={event => setDraft(event.target.value)} onBlur={() => { setFocused(false); commit(); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}
