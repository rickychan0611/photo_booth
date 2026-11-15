import { KioskButton } from '../KioskButton';
import { POSE_CATEGORIES, POSE_CATEGORY_LABELS, type PoseCategory } from './types';

export function GuestPoseCategoryScreen({ onChoose }: { onChoose(category: PoseCategory): void }) {
  return <section className="guest-pose-category-screen" aria-labelledby="pose-category-heading">
    <h1 id="pose-category-heading">Who’s joining the photo?</h1>
    <div className="guest-pose-category-options">
      {POSE_CATEGORIES.map(category => (
        <KioskButton key={category} onPress={() => onChoose(category)}>{POSE_CATEGORY_LABELS[category]}</KioskButton>
      ))}
    </div>
  </section>;
}
