import type { CSSProperties } from 'react';
import type { CameraControlSettings } from './types';

export type CameraRangeCapability = {
  min: number;
  max: number;
  step?: number;
};

export type CameraCapabilitiesMap = Partial<
  Record<keyof CameraControlSettings, CameraRangeCapability>
>;

export const SOFTWARE_CAMERA_KEYS = ['brightness', 'contrast', 'saturation'] as const;

export type SoftwareCameraKey = (typeof SOFTWARE_CAMERA_KEYS)[number];

export const SOFTWARE_CAMERA_DEFAULT = 50;

export const isSoftwareCameraKey = (key: keyof CameraControlSettings): key is SoftwareCameraKey =>
  (SOFTWARE_CAMERA_KEYS as readonly string[]).includes(key);

export function softwareCameraFilter(
  controls: CameraControlSettings,
  capabilities: CameraCapabilitiesMap
): string | undefined {
  const filters: string[] = [];

  for (const key of SOFTWARE_CAMERA_KEYS) {
    if (capabilities[key]) continue;
    const value = controls[key] ?? SOFTWARE_CAMERA_DEFAULT;
    const multiplier = value / SOFTWARE_CAMERA_DEFAULT;
    if (key === 'brightness') filters.push(`brightness(${multiplier})`);
    if (key === 'contrast') filters.push(`contrast(${multiplier})`);
    if (key === 'saturation') filters.push(`saturate(${multiplier})`);
  }

  return filters.length > 0 ? filters.join(' ') : undefined;
}

export function getCameraVideoStyle(
  controls: CameraControlSettings,
  capabilities: CameraCapabilitiesMap
): CSSProperties | undefined {
  const filter = softwareCameraFilter(controls, capabilities);
  return filter ? { filter } : undefined;
}
