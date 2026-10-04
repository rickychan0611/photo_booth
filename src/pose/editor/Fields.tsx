import { useEffect, useState } from 'react';

export function TextField({ label, value, onSave }: { label: string; value: string; onSave(value: string): void }) {
  const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);
  return <label>{label}<input value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => { onSave(draft); setDraft(value); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}
export function NumberField({ label, value, onSave, min, max, step = .1 }: { label: string; value: number; onSave(value: number): void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState(String(value)); useEffect(() => setDraft(String(value)), [value]);
  return <label>{label}<input type="number" value={draft} min={min} max={max} step={step} onChange={event => setDraft(event.target.value)} onBlur={() => { if (draft.trim() && Number.isFinite(Number(draft))) onSave(Number(draft)); setDraft(String(value)); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}
