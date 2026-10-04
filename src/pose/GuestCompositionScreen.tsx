import { ArrowRight } from 'lucide-react';
import { KioskButton } from '../KioskButton';
import { totalPeople } from './scenes';
import type { GuestComposition } from './types';

const labels = { men: 'Men', women: 'Women', boys: 'Boys', girls: 'Girls' } as const;
const singular = { men: 'man', women: 'woman', boys: 'boy', girls: 'girl' } as const;
export function CompositionControls({ value, onChange, capacity = 12 }: { value: GuestComposition; onChange(value: GuestComposition): void; capacity?: number }) {
  const total = totalPeople(value);
  const setCount = (key: keyof typeof labels, difference: number) => {
    const next = { ...value, [key]: Math.max(0, value[key] + difference) };
    const count = totalPeople(next);
    if (count <= 1) next.style = 'solo';
    else if (next.style === 'solo' || (next.style === 'couple' && (next.men + next.women !== 2 || next.boys + next.girls > 0))) next.style = '';
    onChange(next);
  };
  return <div className="composition-controls">
    <div className="people-counters">
      {(Object.keys(labels) as Array<keyof typeof labels>).map(key => <div className={`people-counter${value[key] > 0 ? ' has-people' : ''}`} key={key}>
        <span>{labels[key]}</span>
        <KioskButton aria-label={`Remove one ${singular[key]}`} disabled={value[key] === 0} onPress={() => setCount(key, -1)}>−</KioskButton>
        <output aria-label={`${labels[key]} count`}>{value[key]}</output>
        <KioskButton aria-label={`Add one ${singular[key]}`} disabled={total >= capacity} onPress={() => setCount(key, 1)}>+</KioskButton>
      </div>)}
    </div>
    <p className="people-total" aria-live="polite">{total ? `${total} ${total === 1 ? 'person' : 'people'} ready` : 'Add at least one person'}</p>
    {total > 1 && <div className="pose-style-section">
      <p className="pose-style-label">Your group type</p>
      <div className="pose-style-options" role="group" aria-label="Pick your pose style">
        {(['couple', 'friends', 'family', 'group'] as const).filter(style => style !== 'couple' || (value.men + value.women === 2 && value.boys + value.girls === 0)).map(style => <KioskButton key={style} aria-pressed={value.style === style} onPress={() => onChange({ ...value, style })}>{style === 'couple' ? 'Lovers' : style === 'group' ? 'Weirdos' : style.charAt(0).toUpperCase() + style.slice(1)}</KioskButton>)}
      </div>
    </div>}
  </div>;
}
export function GuestCompositionScreen({ value, onChange, onContinue, capacity }: { value: GuestComposition; onChange(value: GuestComposition): void; onContinue(): void; capacity: number }) {
  return <section className="guest-composition-screen">
    <div className="guest-composition-upper">
      <div className="guest-composition-heading">
        <h1>Who’s joining the photo?</h1>
      </div>
      <CompositionControls value={value} onChange={onChange} capacity={capacity} />
      <KioskButton className="people-continue" disabled={!totalPeople(value) || (totalPeople(value) > 1 && !value.style)} onPress={onContinue}>Continue <ArrowRight size={18} strokeWidth={1.75} /></KioskButton>
    </div>
  </section>;
}
