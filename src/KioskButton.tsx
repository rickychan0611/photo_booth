import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';

const CLICK_LOCK_MS = 150;
const PRESSED_RESET_MS = 250;
export const SCREEN_OPEN_LOCK_MS = 200;

const GuestScreenLockContext = createContext(false);

export function GuestScreenLockProvider({ step, children }: { step: string; children: ReactNode }) {
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    setLocked(true);
    const timer = window.setTimeout(() => setLocked(false), SCREEN_OPEN_LOCK_MS);
    return () => window.clearTimeout(timer);
  }, [step]);

  return <GuestScreenLockContext.Provider value={locked}>{children}</GuestScreenLockContext.Provider>;
}

function useGuestScreenLocked() {
  return useContext(GuestScreenLockContext);
}

type KioskButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onPress?: () => void;
  onClick?: () => void;
  /** Fire onPress on touch/click down instead of release. Good for instant kiosk picks. */
  activateOnPress?: boolean;
};

export function KioskButton({
  onPress,
  onClick,
  disabled,
  className = '',
  children,
  type = 'button',
  activateOnPress = true,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onLostPointerCapture,
  onKeyDown,
  ...rest
}: KioskButtonProps) {
  const screenLocked = useGuestScreenLocked();
  const interactionDisabled = Boolean(disabled || screenLocked);
  const [pressed, setPressed] = useState(false);
  const lockUntilRef = useRef(0);
  const pressedResetTimerRef = useRef<number | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const activatedRef = useRef(false);

  const clearPressedResetTimer = useCallback(() => {
    if (pressedResetTimerRef.current !== null) {
      window.clearTimeout(pressedResetTimerRef.current);
      pressedResetTimerRef.current = null;
    }
  }, []);

  const resetPressed = useCallback(() => {
    clearPressedResetTimer();
    setPressed(false);
    activePointerIdRef.current = null;
    activatedRef.current = false;
  }, [clearPressedResetTimer]);

  const schedulePressedReset = useCallback(() => {
    clearPressedResetTimer();
    pressedResetTimerRef.current = window.setTimeout(() => {
      resetPressed();
    }, PRESSED_RESET_MS);
  }, [clearPressedResetTimer, resetPressed]);

  const runAction = useCallback(() => {
    const action = onPress ?? onClick;
    if (!action || interactionDisabled) return false;
    const now = Date.now();
    if (now < lockUntilRef.current) return false;
    lockUntilRef.current = now + CLICK_LOCK_MS;
    action();
    return true;
  }, [interactionDisabled, onClick, onPress]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(event);
    if (event.defaultPrevented || interactionDisabled) return;
    if (event.button !== 0) return;
    if (Date.now() < lockUntilRef.current) return;

    event.preventDefault();
    setPressed(true);
    activePointerIdRef.current = event.pointerId;
    activatedRef.current = false;
    schedulePressedReset();

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional on some platforms.
    }

    if (activateOnPress) {
      activatedRef.current = runAction();
    }
  };

  const releasePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release failures.
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerUp?.(event);
    if (event.defaultPrevented) return;

    const isActivePointer = activePointerIdRef.current === event.pointerId;
    if (isActivePointer && pressed && !activatedRef.current) {
      activatedRef.current = runAction();
    }
    if (isActivePointer) {
      releasePointer(event);
      resetPressed();
    }
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerCancel?.(event);
    if (activePointerIdRef.current === event.pointerId) {
      releasePointer(event);
      resetPressed();
    }
  };

  const handlePointerLeave = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerLeave?.(event);
    if (activePointerIdRef.current !== event.pointerId) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      resetPressed();
    }
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onLostPointerCapture?.(event);
    if (activePointerIdRef.current === event.pointerId) {
      resetPressed();
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || interactionDisabled) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    runAction();
  };

  return (
    <button
      {...rest}
      type={type}
      disabled={interactionDisabled}
      className={`kiosk-button${pressed ? ' kiosk-button--pressed' : ''}${screenLocked ? ' kiosk-button--screen-locked' : ''}${className ? ` ${className}` : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      onLostPointerCapture={handleLostPointerCapture}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </button>
  );
}
