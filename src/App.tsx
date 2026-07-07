import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';
import { ArrowUp, Camera, Copy, Download, Expand, ExternalLink, FolderOpen, Globe, Image, Minimize2, Printer, RefreshCw, RotateCw, Settings, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { AiPreset, AiProvider, AiQueueItem, AppSettings, AudioCue, BoothSession, CameraControlSettings, CameraRotation, Capture, ColorFilterPreset, ColorFilterValues, FaceAsset, FaceAssetPack, FaceAssetPlacement, Gallery, GalleryUploadStatus, QueueSnapshot, SavedPhoto, TemplateDesign, TemplateLayout, TemplateSlot, TemplateWorkflowSettings } from './types';
import { createBlankTemplateLayout, createGuideTemplateImage, createTemplatedPhotoLayer, createTemplatedPrintImage, createTemplatedPrintImageFromLayer, defaultTemplateScreenCue, defaultTemplateShotAudioCue, getPrimarySlot, MAX_PHOTOS_TO_TAKE, normalizePhotosToTake, normalizeTemplateLayoutForClient, normalizeTemplateWorkflow, templateDimensions } from './template';
import { FaceAssetStabilizer, FaceTracker, clearFaceAssetCanvas, detectFaces, drawFaceAssets, drawFaceDebugInfo, isGuestSelectableFacePack, loadFaceLandmarker, preloadFaceAssetPack, resolveGuestFaceAssetPack } from './faceAssets';
import { applyFaceBeauty } from './beauty';
import {
  getCameraVideoStyle,
  SOFTWARE_CAMERA_DEFAULT,
  SOFTWARE_CAMERA_KEYS,
  type CameraCapabilitiesMap,
  type CameraRangeCapability,
  type SoftwareCameraKey
} from './cameraImage';
import { GuestScreenLockProvider, KioskButton } from './KioskButton';
import { playAudioCue, playAudioCueObject, stopAllAudio, stopAudioChannel, stopAudioCue } from './audio';
import { createBoothGallerySession, createQueueRealtimeClient, fetchQueueSnapshot, isRealtimeConfigured, isWebQueueConfigured, publicWebUrl, validateBoothCode } from './webBackend';

type GuestStep = 'queue' | 'welcome' | 'style' | 'design' | 'facePack' | 'intro' | 'capture' | 'select' | 'filterPreview' | 'thanks';

type PendingPrint = {
  captures: Capture[];
  indexes: number[];
  templateId: string;
  design: TemplateDesign;
};

type PendingPhoneSubmission = {
  phoneNumber?: string;
  marketingConsentValue?: boolean;
};

type SelectContext = {
  templateId: string;
  design: TemplateDesign;
  slotCount: number;
  autoSelectMs: number;
};

type FilterPreviewAssets = {
  layout: TemplateLayout;
  photoDataUrls: string[];
  templateDataUrl: string;
  facePack: FaceAssetPack | null;
};

const buttonText = (value: string) => `[ ${value} ]`;
const PHONE_MAX_DIGITS = 15;
const FILTER_PREVIEW_MAX_LONG_EDGE = 900;
const SELECT_PREVIEW_MAX_LONG_EDGE = 600;
const COLOR_FILTER_FIELDS: Array<{ key: keyof ColorFilterValues; label: string; min: number; max: number; step?: number }> = [
  { key: 'intensity', label: 'Intensity', min: 0, max: 100 },
  { key: 'brightness', label: 'Brightness', min: -50, max: 50 },
  { key: 'contrast', label: 'Contrast', min: -50, max: 50 },
  { key: 'saturation', label: 'Saturation', min: -50, max: 50 },
  { key: 'warmth', label: 'Warmth', min: -50, max: 50 },
  { key: 'tint', label: 'Tint', min: -50, max: 50 },
  { key: 'hue', label: 'Hue', min: -180, max: 180 },
  { key: 'fade', label: 'Fade', min: 0, max: 50 },
  { key: 'highlights', label: 'Highlights', min: -50, max: 50 },
  { key: 'shadows', label: 'Shadows', min: -50, max: 50 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 50 },
  { key: 'blur', label: 'Blur', min: 0, max: 20 }
];

const colorFilterPreviewCacheKey = (preset: ColorFilterPreset | null) =>
  preset
    ? [
        preset.id,
        preset.updatedAt,
        ...COLOR_FILTER_FIELDS.map(({ key }) => preset.filter[key])
      ].join('|')
    : 'normal';

const filterPreviewCacheKey = (beautyLevel: number, preset: ColorFilterPreset | null) =>
  `beauty:${beautyLevel}|color:${colorFilterPreviewCacheKey(preset)}`;

function formatPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, PHONE_MAX_DIGITS);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  if (digits.length <= 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)} ${digits.slice(-7, -4)} ${digits.slice(-4)}`;
}

function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    void window.photoBooth.getSettings().then(setSettings);
  }, []);

  const refreshSettings = async () => {
    const next = await window.photoBooth.getSettings();
    setSettings(next);
    return next;
  };

  const updateSettings = async (partial: Partial<AppSettings>) => {
    const next = await window.photoBooth.updateSettings(partial);
    setSettings(next);
    return next;
  };

  return { settings, updateSettings, refreshSettings };
}

export function App() {
  const query = new URLSearchParams(window.location.search);
  const windowKind = query.get('window');
  if (windowKind === 'admin') return <AdminApp />;
  if (windowKind === 'facePreview') return <FaceAssetPreviewApp />;
  return <GuestApp />;
}

function GuestApp() {
  const query = new URLSearchParams(window.location.search);
  const shouldOpenPickerPreview = query.get('preview') === 'picker';
  const { settings } = useSettings();
  const [step, setStep] = useState<GuestStep>('welcome');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [captureMessage, setCaptureMessage] = useState('');
  const [captureMessageFadeMs, setCaptureMessageFadeMs] = useState(2000);
  const [error, setError] = useState('');
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedCaptureIndexes, setSelectedCaptureIndexes] = useState<number[]>([]);
  const [selectContext, setSelectContext] = useState<SelectContext | null>(null);
  const [selectCountdown, setSelectCountdown] = useState<number | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedDesignId, setSelectedDesignId] = useState('');
  const [guestFaceAssetPackId, setGuestFaceAssetPackId] = useState<string | null>(null);
  const [pendingPrint, setPendingPrint] = useState<PendingPrint | null>(null);
  const [selectedBeautyLevel, setSelectedBeautyLevel] = useState(0);
  const [selectedColorFilterId, setSelectedColorFilterId] = useState('normal');
  const [filterThumbs, setFilterThumbs] = useState<Record<string, string>>({});
  const [selectPreviewUrls, setSelectPreviewUrls] = useState<Record<number, string>>({});
  const [filterPreviewDataUrl, setFilterPreviewDataUrl] = useState('');
  const [filterCountdown, setFilterCountdown] = useState<number | null>(null);
  const filterPreviewSessionRef = useRef(0);
  const filterPreviewAssetsRef = useRef<Promise<FilterPreviewAssets | null> | null>(null);
  const filterPreviewCacheRef = useRef<Map<string, Promise<string>>>(new Map());
  const [thankYouCountdown, setThankYouCountdown] = useState<number | null>(null);
  const [printedPreview, setPrintedPreview] = useState('');
  const [printedNumber, setPrintedNumber] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isFinalPreparing, setIsFinalPreparing] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot | null>(null);
  const [queueCode, setQueueCode] = useState('');
  const [queueMessage, setQueueMessage] = useState('');
  const [boothSession, setBoothSession] = useState<BoothSession | null>(null);
  const [uploadMessage, setUploadMessage] = useState('');
  const [galleryQrDataUrl, setGalleryQrDataUrl] = useState('');
  const [sessionGalleryUrl, setSessionGalleryUrl] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneSubmitted, setPhoneSubmitted] = useState(false);
  const [phoneEntryMessage, setPhoneEntryMessage] = useState('');
  const [galleryConsent, setGalleryConsent] = useState(true);
  const [marketingConsent, setMarketingConsent] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const faceOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const captureGuideRef = useRef<HTMLDivElement>(null);
  const faceOverlayStabilizerRef = useRef(new FaceAssetStabilizer());
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraCapabilities, setCameraCapabilities] = useState<CameraCapabilitiesMap>({});
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordingCleanupRef = useRef<(() => void) | null>(null);
  const pendingVideoSaveRef = useRef<Promise<string | null> | null>(null);
  const pendingVideoPathRef = useRef<string | null>(null);
  const pendingVideoTicketIdRef = useRef<string | null>(null);
  const isUploadingSessionVideoRef = useRef(false);
  const confirmPrintLockRef = useRef(false);
  const pendingGalleryUploadRef = useRef<{ settings: AppSettings; session: BoothSession | null; finalPath: string } | null>(null);
  const pendingPhoneSubmissionRef = useRef<PendingPhoneSubmission | null>(null);
  const lastShortcutRef = useRef('');
  const sessionRunRef = useRef(0);
  const queueModeEnabled = Boolean(settings?.staffControlQueueMode);
  const templateLayouts = settings?.template.layouts.map(normalizeTemplateLayoutForClient) ?? [];
  const activeTemplateIds = new Set(templateLayouts.map((layout) => layout.id));
  const activeDesigns = settings?.template.designs.filter((design) => design.active && activeTemplateIds.has(design.templateId)) ?? [];
  const selectableTemplates = templateLayouts.filter((layout) =>
    activeDesigns.some((design) => design.templateId === layout.id)
  );
  const selectedTemplate = templateLayouts.find((layout) => layout.id === selectedTemplateId) ?? templateLayouts[0] ?? null;
  const selectedDesign = activeDesigns.find((design) => design.id === selectedDesignId) ?? null;
  const selectedWorkflow = selectedTemplate ? workflowForDesign(selectedTemplate, selectedDesign) : null;
  const selectableGuestFacePacks = settings?.template.faceAssetPacks.filter(isGuestSelectableFacePack) ?? [];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      lastShortcutRef.current = `${lastShortcutRef.current}${event.key.toLowerCase()}`.slice(-5);
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'a') void window.photoBooth.openAdmin();
      if (lastShortcutRef.current === 'admin') void window.photoBooth.openAdmin();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    void window.photoBooth.isGuestFullscreen().then(setIsFullscreen);
    return window.photoBooth.onGuestFullscreenChanged(setIsFullscreen);
  }, []);

  useEffect(() => {
    if (!settings) return;
    setStep(settings.staffControlQueueMode ? 'queue' : 'welcome');
  }, [settings?.staffControlQueueMode]);

  const refreshQueueSnapshot = useCallback(
    async (nextSettings = settings) => {
      if (!nextSettings || !nextSettings.staffControlQueueMode || !isWebQueueConfigured(nextSettings)) return null;
      const snapshot = await fetchQueueSnapshot(nextSettings);
      setQueueSnapshot(snapshot);
      return snapshot;
    },
    [settings]
  );

  useEffect(() => {
    if (!settings?.staffControlQueueMode || !isWebQueueConfigured(settings)) return undefined;

    void refreshQueueSnapshot(settings).catch((error) => {
      setQueueMessage(error instanceof Error ? error.message : 'Queue is not connected.');
    });

    const interval = window.setInterval(() => {
      void refreshQueueSnapshot(settings).catch(() => undefined);
    }, 12000);

    if (!isRealtimeConfigured(settings)) {
      return () => window.clearInterval(interval);
    }

    const supabase = createQueueRealtimeClient(settings);
    const channel = supabase
      ?.channel(`electron-booth-${settings.eventId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'events', filter: `id=eq.${settings.eventId}` },
        () => void refreshQueueSnapshot(settings)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tickets', filter: `event_id=eq.${settings.eventId}` },
        () => void refreshQueueSnapshot(settings)
      )
      .subscribe();

    return () => {
      window.clearInterval(interval);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [
    refreshQueueSnapshot,
    settings?.eventId,
    settings?.staffControlQueueMode,
    settings?.supabasePublishableKey,
    settings?.supabaseUrl,
    settings?.webApiBaseUrl
  ]);

  useEffect(() => {
    if (!settings) return undefined;
    if (!settings.audio.enabled) {
      stopAllAudio();
      return undefined;
    }
    if (step !== 'capture') {
      void playAudioCue(settings, 'backgroundMusic');
    }
    return () => undefined;
  }, [settings?.audio, step]);

  useEffect(() => {
    if (!settings) return;
    const cueByStep: Partial<Record<GuestStep, string>> = {
      welcome: 'welcome',
      style: 'style',
      design: 'design'
    };
    if (step !== 'welcome') stopAudioCue('welcome');
    const cueId = cueByStep[step];
    if (cueId) void playAudioCue(settings, cueId);

    const layout = settings.template.layouts
      .map(normalizeTemplateLayoutForClient)
      .find((item) => item.id === selectedTemplateId);
    const activeTemplateIds = new Set(settings.template.layouts.map((item) => item.id));
    const design =
      settings.template.designs.find(
        (item) => item.active && activeTemplateIds.has(item.templateId) && item.id === selectedDesignId
      ) ?? null;
    const workflow = layout ? workflowForDesign(layout, design) : null;

    if (step === 'intro') void playAudioCueObject(settings, workflow?.screenCues?.intro, workflow?.introMessage);
    if (step === 'facePack') void playAudioCueObject(settings, workflow?.screenCues?.facePack, 'Please choose your face accessories.');
    if (step === 'select') void playAudioCueObject(settings, workflow?.screenCues?.select);
    if (step === 'thanks') void playAudioCueObject(settings, workflow?.screenCues?.thanks, workflow?.thankYouMessage);
  }, [settings, settings?.audio, step, selectedTemplateId, selectedDesignId]);

  useEffect(() => {
    if (step !== 'thanks' || !phoneSubmitted || isFinalPreparing) {
      setThankYouCountdown(null);
      return undefined;
    }
    const totalMs = selectedWorkflow?.thankYouMs ?? settings?.workflow.thankYouMs ?? 3000;
    const seconds = Math.max(1, Math.ceil(totalMs / 1000));
    setThankYouCountdown(seconds);
    const timer = window.setInterval(() => {
      setThankYouCountdown((current) => (current === null ? current : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isFinalPreparing, phoneSubmitted, selectedWorkflow?.thankYouMs, settings?.workflow.thankYouMs, step]);

  useEffect(() => {
    if (step !== 'thanks' || thankYouCountdown !== 0) return;
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setSelectContext(null);
    setSelectCountdown(null);
    setPrintedPreview('');
    setPrintedNumber('');
    setPendingPrint(null);
    setSelectedBeautyLevel(0);
    setSelectedColorFilterId('normal');
    setFilterPreviewDataUrl('');
    setFilterCountdown(null);
    setIsAiGenerating(false);
    setIsFinalPreparing(false);
    setCountdown(null);
    setCaptureMessage('');
    setError('');
    setQueueCode('');
    setQueueMessage('');
    setBoothSession(null);
    setUploadMessage('');
    setGalleryQrDataUrl('');
    setSessionGalleryUrl('');
    setPhoneNumber('');
    setPhoneSubmitted(false);
    setPhoneEntryMessage('');
    setGalleryConsent(true);
    setMarketingConsent(true);
    pendingGalleryUploadRef.current = null;
    pendingPhoneSubmissionRef.current = null;
    confirmPrintLockRef.current = false;
    setThankYouCountdown(null);
    setGuestFaceAssetPackId(null);
    setStep(queueModeEnabled ? 'queue' : 'welcome');
  }, [queueModeEnabled, step, thankYouCountdown]);

  const resetGuestSession = () => {
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setSelectContext(null);
    setSelectCountdown(null);
    setPrintedPreview('');
    setPrintedNumber('');
    setPendingPrint(null);
    setSelectedBeautyLevel(0);
    setSelectedColorFilterId('normal');
    setFilterPreviewDataUrl('');
    setFilterCountdown(null);
    setSelectPreviewUrls({});
    setIsAiGenerating(false);
    setIsFinalPreparing(false);
    setCountdown(null);
    setCaptureMessage('');
    setError('');
    setQueueCode('');
    setQueueMessage('');
    setBoothSession(null);
    setUploadMessage('');
    setGalleryQrDataUrl('');
    setSessionGalleryUrl('');
    setPhoneNumber('');
    setPhoneSubmitted(false);
    setPhoneEntryMessage('');
    setGalleryConsent(true);
    setMarketingConsent(true);
    setThankYouCountdown(null);
    setGuestFaceAssetPackId(null);
    pendingGalleryUploadRef.current = null;
    pendingPhoneSubmissionRef.current = null;
    confirmPrintLockRef.current = false;
    setStep(queueModeEnabled ? 'queue' : 'welcome');
  };

  useEffect(() => {
    if (!settings || !shouldOpenPickerPreview) return;
    void openPickerPreview();
  }, [settings, shouldOpenPickerPreview]);

  useEffect(() => {
    if (!settings) return undefined;
    return window.photoBooth.onOpenGuestPickerPreview(() => {
      void openPickerPreview();
    });
  }, [settings]);

  useEffect(() => {
    if (!settings) return;
    const activeTemplateIds = new Set(settings.template.layouts.map((layout) => layout.id));
    const firstActive = settings.template.designs.find((design) => design.active && activeTemplateIds.has(design.templateId));
    setSelectedTemplateId(firstActive?.templateId ?? settings.template.selectedTemplateId ?? '');
    setSelectedDesignId(firstActive?.id ?? settings.template.selectedDesignId ?? '');
  }, [settings?.template.designs, settings?.template.layouts, settings?.template.selectedTemplateId, settings?.template.selectedDesignId]);

  useEffect(() => {
    const releaseCamera = () => {
      sessionRunRef.current += 1;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      mediaRecorderRef.current = null;
      recordStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordStreamRef.current = null;
      stopCamera();
    };
    window.addEventListener('beforeunload', releaseCamera);
    window.addEventListener('pagehide', releaseCamera);
    return () => {
      window.removeEventListener('beforeunload', releaseCamera);
      window.removeEventListener('pagehide', releaseCamera);
      stopAllAudio();
      releaseCamera();
    };
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraCapabilities({});
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  };

  const attachCameraStream = async (stream: MediaStream) => {
    await waitFor(() => videoRef.current);
    if (!videoRef.current) throw new Error('Camera view not ready.');
    if (videoRef.current.srcObject !== stream) videoRef.current.srcObject = stream;
    await videoRef.current.play();
  };

  const startCamera = async (quality: 'preview' | 'capture' = 'capture', options: { forceRestart?: boolean } = {}) => {
    if (!settings) throw new Error('Settings not ready.');
    if (streamRef.current && !options.forceRestart) {
      await attachCameraStream(streamRef.current);
      return;
    }
    stopCamera();
    const videoSettings: MediaTrackConstraints = quality === 'preview'
      ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      : {
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 }
        };
    const constraints: MediaStreamConstraints = {
      video: settings.cameraId ? { ...videoSettings, deviceId: { exact: settings.cameraId } } : videoSettings,
      audio: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    setCameraCapabilities(getCameraCapabilities(stream));
    await applyCameraControls(stream, settings.cameraControls);
    streamRef.current = stream;
    await attachCameraStream(stream);
  };

  useEffect(() => {
    if (!settings) return undefined;
    const needsPreviewCamera = step === 'welcome' || step === 'facePack';
    if (!needsPreviewCamera) {
      if (step !== 'intro' && step !== 'capture') stopCamera();
      return undefined;
    }
    let active = true;
    void startCamera('preview').catch((error) => {
      if (active) console.warn('Guest camera preview unavailable.', error);
    });
    return () => {
      active = false;
    };
  }, [settings, step]);

  const pickRecorderMimeType = () => {
    const candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=h264,opus',
      'video/webm'
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
  };

  const stopRecordingTracks = () => {
    recordStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordStreamRef.current = null;
    recordingCleanupRef.current?.();
    recordingCleanupRef.current = null;
  };

  // Captures the full on-screen composite (camera + face-asset overlays +
  // countdown/messages) of the booth window plus microphone audio. If mirror
  // preview is enabled, the saved MP4 is flipped during transcode so playback is
  // natural while the guest can still see a mirrored live preview.
  const startSessionRecording = async () => {
    if (mediaRecorderRef.current || typeof MediaRecorder === 'undefined') return;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 15 },
          width: { ideal: 854, max: 854 },
          height: { ideal: 480, max: 480 }
        },
        audio: false
      });
      const tracks = [...displayStream.getVideoTracks()];
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000
          },
          video: false
        });
        tracks.push(...micStream.getAudioTracks());
      } catch (audioError) {
        console.warn('Microphone unavailable for session recording.', audioError);
      }
      const merged = new MediaStream(tracks);
      recordStreamRef.current = merged;
      recordedChunksRef.current = [];
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(merged, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 1_500_000,
        audioBitsPerSecond: 96_000
      });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(2000);
      console.log('[video] session recording started', { mimeType: recorder.mimeType, tracks: merged.getTracks().map((t) => t.kind) });
    } catch (error) {
      console.warn('[video] could not start session recording.', error);
      stopRecordingTracks();
      mediaRecorderRef.current = null;
    }
  };

  // Stops recording immediately and saves/transcodes in the background, so the
  // guest flow can move to selection/final output without waiting on ffmpeg.
  const stopSessionRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    mediaRecorderRef.current = null;
    pendingVideoSaveRef.current = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        if (recorder.state !== 'inactive') recorder.stop();
        else resolve();
      })
      .then(async () => {
      stopRecordingTracks();
      const chunks = recordedChunksRef.current;
      recordedChunksRef.current = [];
        if (chunks.length === 0) return null;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const buffer = await blob.arrayBuffer();
      console.log('[video] stopping recording, saving', { bytes: buffer.byteLength });
      const saved = await window.photoBooth.saveSessionVideo({ data: buffer });
      pendingVideoPathRef.current = saved.path;
      console.log('[video] saved locally at', saved.path);
        void flushSessionVideoUpload();
        return saved.path;
      })
      .catch((error) => {
        console.warn('[video] could not finalize session recording.', error);
        stopRecordingTracks();
        return null;
      });
  };

  const flushSessionVideoUpload = async (ticketId?: string) => {
    if (ticketId) pendingVideoTicketIdRef.current = ticketId;
    const uploadTicketId = pendingVideoTicketIdRef.current;
    if (!uploadTicketId || isUploadingSessionVideoRef.current) return;
    isUploadingSessionVideoRef.current = true;
    const videoPath = pendingVideoPathRef.current ?? (pendingVideoSaveRef.current ? await pendingVideoSaveRef.current : null);
    if (!videoPath) {
      isUploadingSessionVideoRef.current = false;
      return;
    }
    try {
      console.log('[video] starting background upload', { ticketId: uploadTicketId, videoPath });
      await window.photoBooth.uploadSessionVideo({ ticketId: uploadTicketId, videoPath });
      pendingVideoPathRef.current = null;
      pendingVideoSaveRef.current = null;
      pendingVideoTicketIdRef.current = null;
      console.log('[video] background upload queued');
    } catch (error) {
      console.warn('Could not upload session video.', error);
    } finally {
      isUploadingSessionVideoRef.current = false;
    }
  };

  const captureFrame = async (slot: TemplateSlot, useFullLiveView = false) => {
    if (!videoRef.current || !settings) throw new Error('Camera not ready.');

    // Render the camera view directly from the camera's native resolution. A
    // plain window screenshot is capped by the guest screen's physical pixel
    // density, which is usually far lower than what the camera actually
    // captures -- that mismatch is what made prints look soft/blurry.
    setIsCapturing(true);
    await nextPaint();

    try {
      const video = videoRef.current;
      const composed = captureNativeResolutionFrame(video, settings, window.innerWidth, window.innerHeight);

      let dataUrl: string;
      if (composed && !useFullLiveView && captureGuideRef.current) {
        const bounds = captureGuideRef.current.getBoundingClientRect();
        const { canvas, outputScale } = composed;
        const cropX = Math.max(0, Math.round(bounds.left * outputScale));
        const cropY = Math.max(0, Math.round(bounds.top * outputScale));
        const cropWidth = Math.max(1, Math.min(canvas.width - cropX, Math.round(bounds.width * outputScale)));
        const cropHeight = Math.max(1, Math.min(canvas.height - cropY, Math.round(bounds.height * outputScale)));
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropWidth;
        cropCanvas.height = cropHeight;
        const cropCtx = cropCanvas.getContext('2d');
        if (!cropCtx) throw new Error('Canvas is not available.');
        cropCtx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
        dataUrl = cropCanvas.toDataURL('image/png');
      } else if (composed) {
        dataUrl = composed.canvas.toDataURL('image/png');
      } else {
        // Fallback for the rare case the video frame isn't ready yet.
        let rect: { x: number; y: number; width: number; height: number } | undefined;
        if (!useFullLiveView && captureGuideRef.current) {
          const bounds = captureGuideRef.current.getBoundingClientRect();
          rect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
        }
        dataUrl = await window.photoBooth.capturePage(rect);
      }

      // Cover-crop to the slot's exact aspect ratio so it drops into the print
      // frame without stretching, for every template style.
      const finalDataUrl = await coverCropToAspect(dataUrl, slot.width / slot.height, slot.cropY);
      setIsFlashing(true);
      window.setTimeout(() => setIsFlashing(false), 180);
      const saved = await window.photoBooth.saveImage({ dataUrl: finalDataUrl, kind: 'original', filenamePrefix: 'original' });
      return { dataUrl: finalDataUrl, ...saved };
    } finally {
      setIsCapturing(false);
    }
  };

  const runCountdown = async (runId: number) => {
    for (const value of [3, 2, 1]) {
      if (sessionRunRef.current !== runId) return false;
      setCountdown(value);
      if (settings) void playAudioCue(settings, `countdown${value}`, String(value));
      await delay(1000);
    }
    setCountdown(null);
    return true;
  };

  const activeFacePack = settings ? resolveGuestFaceAssetPack(settings, guestFaceAssetPackId) : null;
  const activeColorFilterPresets = settings?.template.colorFilterPresets.filter((preset) => preset.active) ?? [];
  const selectedColorPreset = selectedColorFilterId === 'normal'
    ? null
    : activeColorFilterPresets.find((preset) => preset.id === selectedColorFilterId) ?? null;

  const applyFaceAssetsToPhoto = async (dataUrl: string, facePack: FaceAssetPack | null) => {
    if (!facePack) return dataUrl;
    const image = await loadDataUrlImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not apply face assets.');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    try {
      const result = await detectFaces(canvas, performance.now());
      await drawFaceAssets(ctx, result, facePack, canvas.width, canvas.height);
    } catch (error) {
      console.warn('Face assets print burn-in skipped.', error);
    }
    return canvas.toDataURL('image/png');
  };

  const applyFaceAssetsToPhotos = async (dataUrls: string[], facePack: FaceAssetPack | null) => {
    const next: string[] = [];
    for (const dataUrl of dataUrls) {
      next.push(await applyFaceAssetsToPhoto(dataUrl, facePack));
    }
    return next;
  };

  const createProcessedPrintImage = async (
    request: PendingPrint,
    beautyLevel: number,
    colorPreset: ColorFilterPreset | null,
    options: { maxLongEdge?: number; previewPhotos?: boolean } = {}
  ) => {
    if (!settings) return '';
    const layout = templateLayouts.find((item) => item.id === request.templateId);
    if (!layout) return '';
    const baseDataUrls = request.indexes
      .slice(0, layout.photoWindows.length)
      .map((index) => request.captures[index]?.dataUrl)
      .filter(Boolean) as string[];
    if (baseDataUrls.length < layout.photoWindows.length) return '';
    const printReady = settings.mirrorPreview
      ? await Promise.all(baseDataUrls.map(flipPhotoForPrint))
      : baseDataUrls;
    const photoDataUrls = options.previewPhotos
      ? await Promise.all(printReady.map((dataUrl) => downscaleDataUrl(dataUrl, FILTER_PREVIEW_MAX_LONG_EDGE)))
      : printReady;
    const facePack = resolveGuestFaceAssetPack(settings, guestFaceAssetPackId);
    const withFaceAssets = await applyFaceAssetsToPhotos(photoDataUrls, facePack);
    const activeBeautyLevel = settings.beautyFilter.enabledMode === 'off' ? 0 : beautyLevel;
    const photoLayer = await createTemplatedPhotoLayer(
      withFaceAssets,
      layout,
      options.maxLongEdge ? { maxLongEdge: options.maxLongEdge } : undefined
    );
    const filteredPhotoLayer = colorPreset || activeBeautyLevel > 0
      ? await applyPhotoFilters(photoLayer, colorPreset, activeBeautyLevel)
      : photoLayer;
    const templateDataUrl = await window.photoBooth.getImageDataUrl(templateFramePath(request.design));
    return createTemplatedPrintImageFromLayer(
      filteredPhotoLayer,
      layout,
      request.design,
      templateDataUrl,
      options.maxLongEdge ? { maxLongEdge: options.maxLongEdge } : undefined
    );
  };

  const getFilterPreviewAssets = () => {
    if (filterPreviewAssetsRef.current) return filterPreviewAssetsRef.current;
    const request = pendingPrint;
    if (!request || !settings) return Promise.resolve(null);
    const layout = templateLayouts.find((item) => item.id === request.templateId);
    if (!layout) return Promise.resolve(null);

    const promise = (async (): Promise<FilterPreviewAssets | null> => {
      const baseDataUrls = request.indexes
        .slice(0, layout.photoWindows.length)
        .map((index) => request.captures[index]?.dataUrl)
        .filter(Boolean) as string[];
      if (baseDataUrls.length < layout.photoWindows.length) return null;
      const printReady = settings.mirrorPreview
        ? await Promise.all(baseDataUrls.map(flipPhotoForPrint))
        : baseDataUrls;
      const [photoDataUrls, templateDataUrl] = await Promise.all([
        Promise.all(printReady.map((dataUrl) => downscaleDataUrl(dataUrl, FILTER_PREVIEW_MAX_LONG_EDGE))),
        window.photoBooth.getImageDataUrl(templateFramePath(request.design))
      ]);
      return { layout, photoDataUrls, templateDataUrl, facePack: resolveGuestFaceAssetPack(settings, guestFaceAssetPackId) };
    })().catch((error) => {
      filterPreviewAssetsRef.current = null;
      throw error;
    });

    filterPreviewAssetsRef.current = promise;
    return promise;
  };

  const getCachedFilterPreview = (
    beautyLevel: number,
    colorPreset: ColorFilterPreset | null
  ) => {
    const activeBeautyLevel = settings?.beautyFilter.enabledMode === 'off' ? 0 : beautyLevel;
    const key = filterPreviewCacheKey(activeBeautyLevel, colorPreset);
    const cached = filterPreviewCacheRef.current.get(key);
    if (cached) return cached;

    const renderPromise = (async () => {
      const assets = await getFilterPreviewAssets();
      if (!assets) return '';
      const withFaceAssets = await applyFaceAssetsToPhotos(assets.photoDataUrls, assets.facePack);
      if (withFaceAssets.length < assets.layout.photoWindows.length) return '';
      const photoLayer = await createTemplatedPhotoLayer(
        withFaceAssets,
        assets.layout,
        { maxLongEdge: FILTER_PREVIEW_MAX_LONG_EDGE }
      );
      const filteredPhotoLayer = colorPreset || activeBeautyLevel > 0
        ? await applyPhotoFilters(photoLayer, colorPreset, activeBeautyLevel)
        : photoLayer;
      return createTemplatedPrintImageFromLayer(
        filteredPhotoLayer,
        assets.layout,
        pendingPrint?.design,
        assets.templateDataUrl,
        { maxLongEdge: FILTER_PREVIEW_MAX_LONG_EDGE }
      );
    })();

    const cachedPromise = renderPromise.catch((error) => {
      filterPreviewCacheRef.current.delete(key);
      throw error;
    });
    filterPreviewCacheRef.current.set(key, cachedPromise);
    return cachedPromise;
  };

  const prepareFilterPreview = async (
    sourceCaptures: Capture[],
    indexes: number[],
    templateId: string,
    design: TemplateDesign
  ) => {
    filterPreviewSessionRef.current += 1;
    filterPreviewAssetsRef.current = null;
    filterPreviewCacheRef.current.clear();
    setPendingPrint({ captures: sourceCaptures, indexes, templateId, design });
    setSelectedBeautyLevel(0);
    setSelectedColorFilterId('normal');
    setFilterThumbs({});
    setFilterPreviewDataUrl('');
    setFilterCountdown(Math.max(1, Math.ceil((settings?.beautyFilter.previewTimeoutMs ?? 30000) / 1000)));
    setStep('filterPreview');
  };

  const finalizeSelection = (indexes: number[]) => {
    const context = selectContext;
    if (!context) return;
    const final = indexes.slice(0, context.slotCount);
    for (let index = 0; index < captures.length && final.length < context.slotCount; index += 1) {
      if (!final.includes(index)) final.push(index);
    }
    if (final.length < context.slotCount) return;
    setSelectedCaptureIndexes(final);
    setSelectContext(null);
    setSelectCountdown(null);
    if (settings) void playAudioCue(settings, 'button');
    void prepareFilterPreview(captures, final, context.templateId, context.design);
  };

  const toggleCaptureSelection = (index: number) => {
    if (!selectContext) return;
    setSelectedCaptureIndexes((current) => {
      if (current.includes(index)) return current.filter((item) => item !== index);
      // At capacity: replace the oldest pick so the guest can swap immediately
      // without having to deselect one first.
      return [...current, index].slice(-selectContext.slotCount);
    });
  };

  useEffect(() => {
    if (step !== 'select' || !selectContext) return undefined;
    setSelectCountdown(Math.max(1, Math.ceil(selectContext.autoSelectMs / 1000)));
    const timer = window.setInterval(() => {
      setSelectCountdown((value) => (value === null ? value : Math.max(0, value - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, selectContext]);

  useEffect(() => {
    if (step !== 'select' || selectCountdown !== 0 || !selectContext) return;
    finalizeSelection(selectedCaptureIndexes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectCountdown, step, selectContext]);

  const confirmFilterPrint = async () => {
    if (!pendingPrint || confirmPrintLockRef.current) return;
    confirmPrintLockRef.current = true;
    setIsBusy(true);
    setFilterCountdown(null);
    const request = pendingPrint;
    const beautyLevel = selectedBeautyLevel;
    const colorPreset = selectedColorPreset;
    setPendingPrint(null);
    void printCaptures(request.captures, request.indexes, request.templateId, request.design, undefined, {
      beautyLevel,
      colorPreset
    });
  };

  useEffect(() => {
    if (step !== 'filterPreview' || !pendingPrint || !settings) return undefined;
    let active = true;
    const sessionId = filterPreviewSessionRef.current;
    const activeBeautyLevel = settings.beautyFilter.enabledMode === 'off' ? 0 : selectedBeautyLevel;
    const requestedKey = filterPreviewCacheKey(activeBeautyLevel, selectedColorPreset);
    void (async () => {
      try {
        const preview = await getCachedFilterPreview(activeBeautyLevel, selectedColorPreset);
        const currentBeautyLevel = settings.beautyFilter.enabledMode === 'off' ? 0 : selectedBeautyLevel;
        const currentKey = filterPreviewCacheKey(currentBeautyLevel, selectedColorPreset);
        if (active && preview && sessionId === filterPreviewSessionRef.current && requestedKey === currentKey) {
          setFilterPreviewDataUrl(preview);
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : 'Could not preview filters.');
      }
    })();
    return () => {
      active = false;
    };
  }, [pendingPrint, selectedBeautyLevel, selectedColorFilterId, settings, step]);

  useEffect(() => {
    if (step !== 'filterPreview' || !pendingPrint || !settings || !filterPreviewDataUrl) return undefined;
    let active = true;
    const sessionId = filterPreviewSessionRef.current;
    void (async () => {
      try {
        if (selectedColorFilterId !== 'normal') await getCachedFilterPreview(0, null);
        if (!active || sessionId !== filterPreviewSessionRef.current) return;
        for (const preset of activeColorFilterPresets) {
          if (!active || sessionId !== filterPreviewSessionRef.current) return;
          if (preset.id === selectedColorFilterId) continue;
          await getCachedFilterPreview(0, preset);
        }
      } catch {
        // The active preview effect reports user-facing errors; prewarm can fail silently.
      }
    })();
    return () => {
      active = false;
    };
  }, [filterPreviewDataUrl, guestFaceAssetPackId, pendingPrint, selectedColorFilterId, settings, step]);

  useEffect(() => {
    if (step !== 'select' || !settings || captures.length === 0) {
      if (step !== 'select') setSelectPreviewUrls({});
      return undefined;
    }
    let active = true;
    void (async () => {
      try {
        const facePack = resolveGuestFaceAssetPack(settings, guestFaceAssetPackId);
        const entries = await Promise.all(
          captures.map(async (capture, index) => {
            if (!capture.dataUrl) return [index, ''] as const;
            let source = capture.dataUrl;
            if (settings.mirrorPreview) {
              source = await flipPhotoForPrint(source);
            }
            const withFace = await applyFaceAssetsToPhoto(source, facePack);
            const thumb = await downscaleDataUrl(withFace, SELECT_PREVIEW_MAX_LONG_EDGE);
            return [index, thumb] as const;
          })
        );
        if (!active) return;
        const next: Record<number, string> = {};
        entries.forEach(([index, src]) => {
          if (src) next[index] = src;
        });
        setSelectPreviewUrls(next);
      } catch {
        if (active) setSelectPreviewUrls({});
      }
    })();
    return () => {
      active = false;
    };
  }, [captures, guestFaceAssetPackId, settings, step]);

  // Build live per-preset thumbnails from the last captured photo (color only,
  // small + cached) so guests preview each filter on their own picture.
  useEffect(() => {
    if (step !== 'filterPreview' || !pendingPrint || !settings) return undefined;
    let active = true;
    void (async () => {
      try {
        const lastCapture = pendingPrint.captures[pendingPrint.captures.length - 1];
        if (!lastCapture?.dataUrl) return;
        const smallDataUrl = await downscaleDataUrl(lastCapture.dataUrl, 220);
        const facePack = resolveGuestFaceAssetPack(settings, guestFaceAssetPackId);
        const thumbSourceDataUrl = await applyFaceAssetsToPhoto(smallDataUrl, facePack);
        const presets = settings.template.colorFilterPresets.filter((preset) => preset.active);
        const entries = await Promise.all([
          (async () => ['normal', thumbSourceDataUrl] as const)(),
          ...presets.map(async (preset) => {
            try {
              const thumb = await applyPhotoFilters(thumbSourceDataUrl, preset, 0);
              return [preset.id, thumb] as const;
            } catch {
              return [preset.id, ''] as const;
            }
          })
        ]);
        if (!active) return;
        const next: Record<string, string> = {};
        entries.forEach(([id, src]) => {
          if (src) next[id] = src;
        });
        setFilterThumbs(next);
      } catch {
        // Leave thumbnails empty; buttons fall back to static sample images.
      }
    })();
    return () => {
      active = false;
    };
  }, [guestFaceAssetPackId, pendingPrint, settings, step]);

  useEffect(() => {
    if (step !== 'filterPreview' || !pendingPrint || !settings) return undefined;
    setFilterCountdown(Math.max(1, Math.ceil(settings.beautyFilter.previewTimeoutMs / 1000)));
    const timer = window.setInterval(() => {
      setFilterCountdown((current) => (current === null ? current : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pendingPrint?.templateId, settings?.beautyFilter.previewTimeoutMs, step]);

  useEffect(() => {
    if (step !== 'filterPreview' || filterCountdown !== 0 || !pendingPrint) return;
    void confirmFilterPrint();
  }, [filterCountdown, pendingPrint, step]);

  useEffect(() => {
    if (!settings || selectableGuestFacePacks.length === 0) return;
    void Promise.all([
      loadFaceLandmarker(),
      ...selectableGuestFacePacks.map((pack) => preloadFaceAssetPack(pack))
    ]).catch((error) => {
      console.warn('Face assets preload skipped.', error);
    });
  }, [settings?.template.faceAssetPacks]);

  useEffect(() => {
    const canvas = faceOverlayCanvasRef.current;
    const showFaceOverlay = step === 'capture' || step === 'facePack';
    if (!settings || !canvas || !showFaceOverlay) {
      if (canvas) clearFaceAssetCanvas(canvas, canvas.width, canvas.height);
      faceOverlayStabilizerRef.current.reset();
      return undefined;
    }

    let animationFrame = 0;
    let canceled = false;
    let busy = false;
    let lastDetectionAt = 0;
    let missedFrames = 0;
    const tracker = new FaceTracker();

    const drawOverlay = (now: number) => {
      if (!canceled) animationFrame = window.requestAnimationFrame(drawOverlay);
      const video = videoRef.current;
      const overlay = faceOverlayCanvasRef.current;
      if (!canceled && video && overlay && video.videoWidth > 0 && video.videoHeight > 0 && !busy && now - lastDetectionAt > 66) {
        busy = true;
        lastDetectionAt = now;
        void (async () => {
          try {
          const displayWidth = Math.max(1, Math.round(overlay.clientWidth));
          const displayHeight = Math.max(1, Math.round(overlay.clientHeight));
          const displayResult = await detectDisplayedFaces(video, displayWidth, displayHeight, settings, now);
          clearFaceAssetCanvas(overlay, displayWidth, displayHeight);
          const ctx = overlay.getContext('2d');
          if (!activeFacePack) {
            faceOverlayStabilizerRef.current.reset();
            tracker.reset();
            return;
          }
          if (displayResult.faceLandmarks.length === 0) {
            missedFrames += 1;
            if (ctx) {
              await drawFaceAssets(ctx, displayResult, activeFacePack, overlay.width, overlay.height, faceOverlayStabilizerRef.current, tracker);
            }
            if (missedFrames > 60) {
              faceOverlayStabilizerRef.current.reset();
              tracker.reset();
            }
            return;
          }
          missedFrames = 0;
          if (ctx) {
            await drawFaceAssets(ctx, displayResult, activeFacePack, overlay.width, overlay.height, faceOverlayStabilizerRef.current, tracker);
          }
        } catch (error) {
          console.warn('Face assets preview skipped.', error);
        } finally {
          busy = false;
        }
        })();
      }
    };

    animationFrame = window.requestAnimationFrame(drawOverlay);
    return () => {
      canceled = true;
      window.cancelAnimationFrame(animationFrame);
      clearFaceAssetCanvas(canvas, canvas.width, canvas.height);
      faceOverlayStabilizerRef.current.reset();
    };
  }, [activeFacePack, settings?.cameraRotation, settings?.mirrorPreview, step]);

  const chooseTemplate = (templateId: string) => {
    if (settings) void playAudioCue(settings, 'button');
    const firstDesign = activeDesigns.find((design) => design.templateId === templateId);
    setSelectedTemplateId(templateId);
    setSelectedDesignId(firstDesign?.id ?? '');
    setSelectedCaptureIndexes([]);
    setStep(firstDesign ? 'design' : 'style');
  };

  const chooseDesign = (design: TemplateDesign) => {
    if (settings) void playAudioCue(settings, 'button');
    setSelectedTemplateId(design.templateId);
    setSelectedDesignId(design.id);
    setGuestFaceAssetPackId(null);
    setSelectedCaptureIndexes([]);
    const hasSelectablePacks = settings?.template.faceAssetPacks.some(isGuestSelectableFacePack) ?? false;
    if (hasSelectablePacks) {
      setStep('facePack');
      return;
    }
    setStep('intro');
    void startSession(design.templateId, design);
  };

  const selectFacePack = (packId: string | null) => {
    if (settings) void playAudioCue(settings, 'button');
    setGuestFaceAssetPackId(packId);
    if (settings && packId) {
      const pack = settings.template.faceAssetPacks.find((candidate) => candidate.id === packId);
      void preloadFaceAssetPack(pack).catch((error) => {
        console.warn('Selected face assets preload skipped.', error);
      });
    }
    faceOverlayStabilizerRef.current.reset();
  };

  const confirmFacePack = () => {
    if (settings) void playAudioCue(settings, 'button');
    setStep('intro');
    void startSession(selectedTemplateId, selectedDesign);
  };

  const startUnqueuedFlow = () => {
    if (!settings) return;
    if (selectableTemplates.length === 1) {
      chooseTemplate(selectableTemplates[0].id);
      return;
    }
    void playAudioCue(settings, 'button');
    setStep('style');
  };

  const appendQueueDigit = (digit: string) => {
    setQueueMessage('');
    setQueueCode((current) => `${current}${digit}`.slice(0, 4));
  };

  const backspaceQueueCode = () => {
    setQueueMessage('');
    setQueueCode((current) => current.slice(0, -1));
  };

  const submitQueueCode = async () => {
    if (!settings || queueCode.length !== 4 || isBusy) return;
    setIsBusy(true);
    setQueueMessage('');
    try {
      const result = await validateBoothCode(settings, queueCode);
      const galleryUrl = publicWebUrl(settings, result.galleryUrl);
      setBoothSession(result);
      setSessionGalleryUrl(galleryUrl);
      setGalleryQrDataUrl(await createGalleryQrCode(galleryUrl));
      setQueueCode('');
      setQueueMessage(`Code accepted for queue #${result.ticket.queue_number}.`);
      void playAudioCue(settings, 'button');
      setStep('welcome');
      await refreshQueueSnapshot(settings);
    } catch (error) {
      setQueueMessage(error instanceof Error ? error.message : 'Code is not ready.');
    } finally {
      setIsBusy(false);
    }
  };

  const startSession = async (templateId = selectedTemplateId, design = selectedDesign) => {
    if (!settings || isBusy) return;
    const layout = templateLayouts.find((item) => item.id === templateId);
    if (!layout) return;
    const workflow = workflowForDesign(layout, design);
    const runId = sessionRunRef.current + 1;
    sessionRunRef.current = runId;
    setError('');
    setIsBusy(true);
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setSelectContext(null);
    setSelectCountdown(null);
    setPrintedPreview('');
    setPrintedNumber('');
    setPendingPrint(null);
    setSelectedBeautyLevel(0);
    setSelectedColorFilterId('normal');
    setFilterPreviewDataUrl('');
    setFilterCountdown(null);
    setIsAiGenerating(false);
    setCaptureMessage('');
    setCountdown(null);
    confirmPrintLockRef.current = false;

    try {
      setStep('intro');
      await delay(workflow.introMs);
      if (sessionRunRef.current !== runId) return;
      setStep('capture');
      await delay(100);
      await startCamera('capture', { forceRestart: true });
      if (design?.videoRecordingEnabled) {
        await startSessionRecording();
      }

      const slotCount = layout.photoWindows.length;
      const takeCount = normalizePhotosToTake(layout.photosToTake, slotCount);
      const pickMode = Boolean(design) && takeCount > slotCount;
      const shotPlan = Array.from({ length: takeCount }, (_item, index) => workflow.shots[index % workflow.shots.length]);
      const nextCaptures: Capture[] = [];

      for (const shot of shotPlan) {
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage('');
        await delay(shot.cameraBeforeMessageMs);
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage(shot.message);
        void playAudioCueObject(settings, shot.audioCue, shot.message);
        setCaptureMessageFadeMs(shot.messageMs);
        await delay(shot.messageMs);
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage('');
        await delay(shot.cameraBeforeCountdownMs);
        if (!(await runCountdown(runId))) return;
        // When taking more photos than slots, every shot is a candidate for any
        // slot, so crop them all to the first slot's aspect ratio for a
        // consistent selection grid. Otherwise match each slot in order.
        const guideSlot = pickMode ? getPrimarySlot(layout, 0) : getPrimarySlot(layout, nextCaptures.length);
        const capture = await captureFrame(guideSlot, false);
        void playAudioCue(settings, 'shutter');
        nextCaptures.push(capture);
        setCaptures([...nextCaptures]);
        await delay(350);
      }

      stopSessionRecording();
      stopCamera();
      if (pickMode && design) {
        setSelectedCaptureIndexes([]);
        setSelectContext({
          templateId: layout.id,
          design,
          slotCount,
          autoSelectMs: Math.max(4000, workflow.printAutoSelectMs || 20000)
        });
        setStep('select');
        return;
      }
      const defaultIndexes = Array.from({ length: slotCount }, (_item, index) => index).filter((index) => index < nextCaptures.length);
      setSelectedCaptureIndexes(defaultIndexes);
      if (design) {
        await prepareFilterPreview(nextCaptures, defaultIndexes, layout.id, design);
      } else {
        setStep('thanks');
      }
    } catch {
      stopSessionRecording();
      stopCamera();
      setError('CAMERA NOT READY');
      setStep('welcome');
    } finally {
      setCaptureMessage('');
      setCountdown(null);
      setIsBusy(false);
    }
  };

  const printCaptures = async (
    sourceCaptures: Capture[],
    indexes: number[],
    templateId: string,
    design: TemplateDesign,
    processedPrintDataUrl?: string,
    filterOptions: { beautyLevel?: number; colorPreset?: ColorFilterPreset | null } = {}
  ) => {
    if (!settings) {
      confirmPrintLockRef.current = false;
      setIsBusy(false);
      return;
    }
    const layout = templateLayouts.find((item) => item.id === templateId);
    if (!layout) {
      confirmPrintLockRef.current = false;
      setIsBusy(false);
      return;
    }
    const request = { captures: sourceCaptures, indexes, templateId, design };
    if (!processedPrintDataUrl && indexes.slice(0, layout.photoWindows.length).some((index) => !sourceCaptures[index]?.dataUrl)) {
      confirmPrintLockRef.current = false;
      setIsBusy(false);
      return;
    }
    stopAudioChannel('voice');
    setPrintedPreview('');
    setPrintedNumber('');
    setUploadMessage('');
    setPhoneNumber('');
    setPhoneSubmitted(false);
    setPhoneEntryMessage('');
    pendingGalleryUploadRef.current = null;
    pendingPhoneSubmissionRef.current = null;
    setIsFinalPreparing(true);
    setIsAiGenerating(design.usesAi);
    setStep('thanks');
    setIsBusy(false);

    const printFinal = async () => {
      let uploadSession = boothSession;
      let uploadGalleryUrl = sessionGalleryUrl;
      let uploadQrDataUrl = galleryQrDataUrl;

      if (!uploadSession && isWebQueueConfigured(settings) && settings.boothSecret.trim()) {
        try {
          console.log('[gallery-upload] creating gallery session for final photo');
          setUploadMessage('Creating online gallery...');
          uploadSession = await createBoothGallerySession(settings);
          uploadGalleryUrl = publicWebUrl(settings, uploadSession.galleryUrl);
          uploadQrDataUrl = await createGalleryQrCode(uploadGalleryUrl);
          setBoothSession(uploadSession);
          setSessionGalleryUrl(uploadGalleryUrl);
          setGalleryQrDataUrl(uploadQrDataUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Could not create online gallery.';
          setUploadMessage(`Gallery upload skipped: ${message}`);
        }
      } else if (uploadSession && uploadGalleryUrl && !uploadQrDataUrl) {
        uploadQrDataUrl = await createGalleryQrCode(uploadGalleryUrl);
        setGalleryQrDataUrl(uploadQrDataUrl);
      }

      let dataUrl = processedPrintDataUrl || await createProcessedPrintImage(
        request,
        filterOptions.beautyLevel ?? 0,
        filterOptions.colorPreset ?? null
      );
      if (!dataUrl) return;
      if (uploadGalleryUrl && uploadQrDataUrl) {
        dataUrl = await addQrToPrintDataUrl(dataUrl, uploadQrDataUrl);
      }
      const printerName = printerForTemplate(settings, layout);
      if (design.usesAi && design.aiPresetId) {
        const result = await window.photoBooth.generateAiFinal({
          dataUrl,
          templateId: layout.id,
          designId: design.id,
          presetId: design.aiPresetId,
          printerName
        });
        setPrintedPreview(result.dataUrl ?? dataUrl);
        if (result.saved) {
          setPrintedNumber(displayedPhotoNumber(result.saved.name, uploadSession));
          pendingGalleryUploadRef.current = { settings, session: uploadSession, finalPath: result.saved.path };
          consumeQueuedPhoneSubmission();
        }
        setIsAiGenerating(false);
        setIsFinalPreparing(false);
        return;
      }
      const saved = await window.photoBooth.saveImage({
        dataUrl,
        kind: 'final',
        filenamePrefix: 'final',
        templateId: layout.id,
        designId: design.id,
        printerName
      });
      setPrintedPreview(dataUrl);
      setPrintedNumber(displayedPhotoNumber(saved.name, uploadSession));
      setIsAiGenerating(false);
      console.log('[gallery-upload] final photo saved', { path: saved.path, hasUploadSession: Boolean(uploadSession) });
      if (uploadSession) {
        console.log('[gallery-upload] final upload waiting for phone entry', { ticketId: uploadSession.ticket.id, galleryUrl: uploadSession.galleryUrl });
        pendingGalleryUploadRef.current = { settings, session: uploadSession, finalPath: saved.path };
      } else if (isWebQueueConfigured(settings) && !settings.boothSecret.trim()) {
        pendingGalleryUploadRef.current = { settings, session: null, finalPath: saved.path };
        setUploadMessage('Gallery upload skipped: Booth secret is missing.');
        console.warn('[gallery-upload] skipped because booth secret is missing');
      } else {
        pendingGalleryUploadRef.current = { settings, session: null, finalPath: saved.path };
        console.warn('[gallery-upload] skipped because web API or event ID is missing');
      }
      if (settings.printerEnabled) {
        void window.photoBooth.printImage(saved.path, printerName).then((result) => {
          if (!result.ok) console.warn(result.error || 'Print canceled.');
        });
      } else {
        console.log('[print] skipped because printer is off');
      }
      consumeQueuedPhoneSubmission();
    };

    try {
      await printFinal();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not prepare photo.');
    } finally {
      setIsFinalPreparing(false);
      setIsAiGenerating(false);
      setIsBusy(false);
    }
  };

  const startBackgroundGalleryUpload = async (
    currentSettings: AppSettings,
    session: BoothSession,
    finalPath: string,
    phoneNumber?: string,
    marketingConsentValue?: boolean
  ) => {
    try {
      setUploadMessage('Gallery upload is running in background...');
      await window.photoBooth.uploadFinalGallery({
        ticketId: session.ticket.id,
        galleryUrl: session.galleryUrl,
        finalPath,
        phoneNumber,
        marketingConsent: marketingConsentValue
      });
      void flushSessionVideoUpload(session.ticket.id);
      await refreshQueueSnapshot(currentSettings);
    } catch (error) {
      setUploadMessage(error instanceof Error ? `Upload failed: ${error.message}` : 'Upload failed.');
    }
  };

  const applyPhoneSubmissionToUpload = (
    pending: { settings: AppSettings; session: BoothSession | null; finalPath: string },
    options: PendingPhoneSubmission
  ) => {
    const normalizedPhone = options.phoneNumber?.replace(/\D/g, '') ?? '';
    if (normalizedPhone) {
      void window.photoBooth.updatePhotoPhoneNumber(pending.finalPath, normalizedPhone).catch((error) => {
        setUploadMessage(error instanceof Error ? `Could not save phone: ${error.message}` : 'Could not save phone.');
      });
    }
    if (pending.session) {
      void startBackgroundGalleryUpload(
        pending.settings,
        pending.session,
        pending.finalPath,
        normalizedPhone || undefined,
        options.marketingConsentValue
      );
    }
  };

  const consumeQueuedPhoneSubmission = () => {
    const queuedPhone = pendingPhoneSubmissionRef.current;
    const pending = pendingGalleryUploadRef.current;
    if (!queuedPhone || !pending) return false;
    pendingPhoneSubmissionRef.current = null;
    pendingGalleryUploadRef.current = null;
    applyPhoneSubmissionToUpload(pending, queuedPhone);
    return true;
  };

  const finishPhoneEntry = (options: { phoneNumber?: string; marketingConsentValue?: boolean }) => {
    setPhoneEntryMessage('');
    setPhoneSubmitted(true);
    const pending = pendingGalleryUploadRef.current;
    pendingGalleryUploadRef.current = null;
    if (!pending) {
      pendingPhoneSubmissionRef.current = options;
      if (isFinalPreparing) setUploadMessage('Photo is still preparing. Upload will start automatically.');
      return;
    }
    applyPhoneSubmissionToUpload(pending, options);
  };

  const submitPhoneNumber = () => {
    const normalizedPhone = phoneNumber.replace(/\D/g, '');
    if (normalizedPhone.length < 7) {
      setPhoneEntryMessage('Please enter a valid phone number.');
      return;
    }
    if (!galleryConsent && !marketingConsent) {
      setPhoneEntryMessage('Please agree to at least one option or tap Skip.');
      return;
    }
    finishPhoneEntry({ phoneNumber: normalizedPhone, marketingConsentValue: marketingConsent });
  };

  const skipPhoneEntry = () => {
    finishPhoneEntry({ marketingConsentValue: false });
  };

  const appendPhoneDigit = (digit: string) => {
    setPhoneEntryMessage('');
    setPhoneNumber((current) => `${current}${digit}`.replace(/\D/g, '').slice(0, PHONE_MAX_DIGITS));
  };

  const openPickerPreview = async () => {
    if (!settings) return;
    try {
      setError('');
      setIsBusy(true);
      stopCamera();
      const gallery = await window.photoBooth.listGallery();
      const latestPhotos = gallery.originals.length > 0 ? gallery.originals : gallery.finals;
      const placeholders = latestPhotos.length >= 4 ? latestPhotos.slice(0, 4) : Array.from({ length: 4 }, () => latestPhotos[0]).filter(Boolean);
      const previewCaptures =
        placeholders.length > 0
          ? await Promise.all(
              placeholders.map(async (photo, index) => ({
                dataUrl: await window.photoBooth.getImageDataUrl(photo.path),
                path: `${photo.path}#preview-${index}`,
                name: photo.name
              }))
            )
          : createPickerPlaceholderCaptures(settings);
      setCaptures(previewCaptures);
      const firstDesign = activeDesigns[0];
      const layout = templateLayouts.find((item) => item.id === firstDesign?.templateId) ?? templateLayouts[0];
      if (!layout) throw new Error('No template ready.');
      setSelectedTemplateId(layout.id);
      setSelectedDesignId(firstDesign?.id ?? '');
      setSelectedCaptureIndexes(Array.from({ length: layout.photoWindows.length }, (_item, index) => index).filter((index) => index < previewCaptures.length));
      setPrintedPreview('');
      setPrintedNumber('');
      setIsAiGenerating(false);
      setCountdown(null);
      setCaptureMessage('');
      if (firstDesign) {
        await printCaptures(previewCaptures, Array.from({ length: layout.photoWindows.length }, (_item, index) => index), layout.id, firstDesign);
      } else {
        setStep('thanks');
      }
    } catch {
      setError('PREVIEW NOT READY');
      setStep('welcome');
    } finally {
      setIsBusy(false);
    }
  };

  if (!settings) return <GuestShell><p className="quiet">LOADING</p></GuestShell>;

  const guestCameraStyle = getCameraVideoStyle(settings.cameraControls, cameraCapabilities);

  return (
    <GuestScreenLockProvider step={step}>
    <GuestShell flash={isFlashing} compactTop={step === 'queue'} thanksLayout={step === 'thanks' || step === 'filterPreview'} filterLayout={step === 'filterPreview'}>
      {!isFullscreen && step !== 'capture' && (
        <KioskButton
          className="fullscreen-button"
          aria-label="Fullscreen"
          title="Fullscreen"
          onPress={() => void window.photoBooth.setGuestFullscreen(true)}
        >
          <Expand size={18} />
        </KioskButton>
      )}

      {step === 'queue' && (
        <QueueEntryScreen
          settings={settings}
          snapshot={queueSnapshot}
          code={queueCode}
          message={queueMessage}
          isBusy={isBusy}
          onDigit={appendQueueDigit}
          onBackspace={backspaceQueueCode}
          onClear={() => setQueueCode('')}
          onSubmit={submitQueueCode}
        />
      )}

      {step === 'welcome' && (
        <section className="welcome-screen">
          <video
            ref={videoRef}
            className={`welcome-live-feed${settings.mirrorPreview ? ' mirror' : ''}${settings.cameraRotation ? ` camera-rotate-${settings.cameraRotation}` : ''}`}
            style={guestCameraStyle}
            playsInline
            muted
          />
          <div className="welcome-live-scrim" aria-hidden="true" />
          <KioskButton
            className="booth-button primary welcome-start-button"
            onPress={() => {
              startUnqueuedFlow();
            }}
            disabled={isBusy}
          >
            TAP TO START
          </KioskButton>
          <div className="welcome-brand-stack">
            <img className="welcome-logo" src={`${import.meta.env.BASE_URL}vibo-logo.png`} alt="Vibo Booth" />
            <p className="welcome-site">vibobooth.com</p>
          </div>
        </section>
      )}

      {step === 'style' && (
        <section className="template-guest-screen">
          <p className="instruction">CHOOSE A TEMPLATE</p>
          {activeDesigns.length === 0 && <p className="quiet">ASK ADMIN TO ADD A TEMPLATE</p>}
          <div className="style-card-grid">
            {templateLayouts.map((layout) => {
              const count = activeDesigns.filter((design) => design.templateId === layout.id).length;
              return (
                <KioskButton key={layout.id} className="style-card" onPress={() => chooseTemplate(layout.id)} disabled={count === 0}>
                  <TemplateMini layout={layout} />
                  <span>{layout.name.toUpperCase()}</span>
                  <small>{layout.photoWindows.length} PHOTO{layout.photoWindows.length === 1 ? '' : 'S'}</small>
                  <small>{count} DESIGN{count === 1 ? '' : 'S'}</small>
                </KioskButton>
              );
            })}
          </div>
        </section>
      )}

      {step === 'design' && (
        <section className="template-guest-screen">
          <KioskButton
            className="guest-back-button"
            onPress={() => {
              void playAudioCue(settings, 'button');
              setStep(selectableTemplates.length === 1 ? 'welcome' : 'style');
            }}
          >
            {buttonText('BACK')}
          </KioskButton>
          <p className="instruction">CHOOSE A DESIGN</p>
          <div className="design-card-grid">
            {activeDesigns
              .filter((design) => design.templateId === selectedTemplateId)
              .map((design) => (
                <KioskButton key={design.id} className="design-card" onPress={() => chooseDesign(design)}>
                  <TemplateImagePreview design={design} />
                  <span>{design.name.toUpperCase()}</span>
                </KioskButton>
              ))}
          </div>
        </section>
      )}

      {step === 'facePack' && (
        <section className="face-pack-screen">
          <video ref={videoRef} className={getCameraVideoClass(settings)} style={guestCameraStyle} playsInline muted />
          <canvas
            ref={faceOverlayCanvasRef}
            className="face-overlay-canvas"
            aria-hidden="true"
          />
          <div className="face-pack-ui">
            <KioskButton
              className="guest-back-button"
              onPress={() => {
                void playAudioCue(settings, 'button');
                setStep('design');
              }}
            >
              {buttonText('BACK')}
            </KioskButton>
            <p className="instruction face-pack-instruction">CHOOSE YOUR STICKERS</p>
            <div className="face-pack-controls">
              <div className="design-card-grid face-pack-card-grid">
                {selectableGuestFacePacks.map((pack) => (
                  <KioskButton
                    key={pack.id}
                    className={`design-card${guestFaceAssetPackId === pack.id ? ' selected' : ''}`}
                    onPress={() => selectFacePack(pack.id)}
                  >
                    <FaceAssetPackPreview pack={pack} />
                    <span>{pack.name.toUpperCase()}</span>
                  </KioskButton>
                ))}
                <KioskButton
                  className={`design-card face-pack-none-card${guestFaceAssetPackId === null ? ' selected' : ''}`}
                  onPress={() => selectFacePack(null)}
                >
                  <div className="design-preview face-pack-none-preview" />
                  <span>NO Stickers</span>
                </KioskButton>
              </div>
              <KioskButton className="booth-button primary face-pack-ok-button" onPress={confirmFacePack}>
                {buttonText('OK')}
              </KioskButton>
            </div>
          </div>
        </section>
      )}

      {step === 'intro' && (
        <section className="welcome-screen">
          <p className="brand">{(selectedWorkflow?.introMessage ?? settings.workflow.introMessage).toUpperCase()}</p>
        </section>
      )}

      {step === 'capture' && (
        <section className="capture-screen">
          <video ref={videoRef} className={getCameraVideoClass(settings)} style={guestCameraStyle} playsInline muted />
          {activeFacePack && (
            <canvas
              ref={faceOverlayCanvasRef}
              className="face-overlay-canvas"
              aria-hidden="true"
            />
          )}
          {/* {!isCapturing && (
            <div className="capture-progress">
              {selectedTemplate ? `${Math.min(captures.length + 1, selectedTemplate.photoWindows.length)} / ${selectedTemplate.photoWindows.length}` : '0 / 0'}
            </div>
          )} */}
          <div ref={captureGuideRef} className="capture-guide-layer" style={slotGuideStyle(getPrimarySlot(selectedTemplate, captures.length))}>
            {!isCapturing && <div className="capture-print-guide" />}
          </div>
          {captureMessage && (
            <div className="capture-message" style={{ '--message-fade-ms': `${captureMessageFadeMs}ms` } as CSSProperties}>
              {captureMessage}
            </div>
          )}
          {countdown && (
            <>
              <div className="capture-camera-arrow" aria-hidden="true">
                <ArrowUp strokeWidth={2.25} />
              </div>
              <div className="countdown">{countdown}</div>
            </>
          )}
        </section>
      )}

      {step === 'select' && selectContext && (() => {
        const selectLayout = templateLayouts.find((item) => item.id === selectContext.templateId) ?? selectedTemplate;
        const selectSlot = getPrimarySlot(selectLayout, 0);
        const hasSlotSize = Boolean(selectSlot && selectSlot.width > 0 && selectSlot.height > 0);
        const tileAspect = hasSlotSize ? `${selectSlot.width} / ${selectSlot.height}` : '3 / 4';
        const isLandscape = hasSlotSize && selectSlot.width > selectSlot.height;
        const maxCols = isLandscape ? 2 : 3;
        const cols = Math.max(1, Math.min(captures.length, maxCols));
        const colMax = isLandscape ? '460px' : '300px';
        return (
        <section
          className="select-screen"
          style={{ '--tile-aspect': tileAspect, '--select-cols': cols, '--select-col-max': colMax } as CSSProperties}
        >
          <div className="select-header">
            <h2>Pick your favorite {selectContext.slotCount}</h2>
            <p>{selectedCaptureIndexes.length} / {selectContext.slotCount} selected</p>
          </div>
          <div className="select-grid">
            {captures.map((capture, index) => {
              const order = selectedCaptureIndexes.indexOf(index);
              const selected = order !== -1;
              return (
                <KioskButton
                  key={capture.path || index}
                  className={`select-tile${selected ? ' selected' : ''}`}
                  onPress={() => {
                    void playAudioCue(settings, 'button');
                    toggleCaptureSelection(index);
                  }}
                >
                  <img src={selectPreviewUrls[index] ?? capture.dataUrl} alt={`Photo ${index + 1}`} />
                  {selected && <span className="select-badge">{order + 1}</span>}
                </KioskButton>
              );
            })}
          </div>
          <div className="select-footer">
            <KioskButton
              className="booth-button primary filter-print-button select-confirm-button"
              onPress={() => finalizeSelection(selectedCaptureIndexes)}
              disabled={selectedCaptureIndexes.length !== selectContext.slotCount}
            >
              <span className="filter-print-button-inner">
                <span className="filter-print-button-label">Continue</span>
                {selectCountdown !== null && (
                  <span className="filter-countdown" aria-label={`Auto-continue in ${selectCountdown} seconds`}>
                    {selectCountdown}
                  </span>
                )}
              </span>
            </KioskButton>
          </div>
        </section>
        );
      })()}

      {step === 'filterPreview' && (
        <section className="filter-preview-screen">
          <div className={`filter-preview-stage${filterPreviewDataUrl ? '' : ' generating'}`}>
            {filterPreviewDataUrl ? <img src={filterPreviewDataUrl} alt="Print preview" /> : <span>PREVIEWING</span>}
          </div>
          <div className="filter-content">
            <div className="filter-controls">
              <div className="filter-control-group">
                <p>Color Filter</p>
                <div className="filter-button-row color-buttons">
                  <div className="filter-choice-item">
                    <KioskButton
                      className={`filter-choice-button${selectedColorFilterId === 'normal' ? ' active' : ''}`}
                      onPress={() => {
                        void playAudioCue(settings, 'button');
                        setSelectedColorFilterId('normal');
                      }}
                      disabled={isBusy}
                    >
                      {filterThumbs.normal && <img src={filterThumbs.normal} alt="" />}
                    </KioskButton>
                    <span className="filter-choice-label">No Filter</span>
                  </div>
                  {activeColorFilterPresets.map((preset) => (
                    <div className="filter-choice-item" key={preset.id}>
                      <KioskButton
                        className={`filter-choice-button${selectedColorFilterId === preset.id ? ' active' : ''}`}
                        onPress={() => {
                          void playAudioCue(settings, 'button');
                          setSelectedColorFilterId(preset.id);
                        }}
                        disabled={isBusy}
                      >
                        {filterThumbs[preset.id] ? (
                          <img src={filterThumbs[preset.id]} alt="" />
                        ) : (
                          <ImagePathThumb path={preset.thumbnailPath} label={preset.name} />
                        )}
                      </KioskButton>
                      <span className="filter-choice-label">{preset.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* {settings.beautyFilter.enabledMode !== 'off' && (
              <div className="filter-control-group beauty-filter-group" style={{ marginBottom: '30px' }}>
                <p style={{ marginTop: '30px' }}>Beauty Filter Level</p>
                <div className="beauty-filter-row">
                  <img
                    className="beauty-filter-icon"
                    src={`${import.meta.env.BASE_URL}beauty-icon.png`}
                    alt=""
                    aria-hidden="true"
                  />
                  <div className="filter-button-row beauty-buttons">
                    {[0, 1, 2, 3].map((level) => (
                      <KioskButton
                        key={level}
                        className={`filter-choice-button${selectedBeautyLevel === level ? ' active' : ''}`}
                        onPress={() => {
                          void playAudioCue(settings, 'button');
                          setSelectedBeautyLevel(level);
                        }}
                      >
                        <span>{level === 0 ? 'No Beauty' : String(level)}</span>
                      </KioskButton>
                    ))}
                  </div>
                </div>
              </div>
              )} */}
            </div>
            <div className="filter-print-row">
              <KioskButton
                className="booth-button primary filter-print-button"
                onPress={() => {
                  void playAudioCue(settings, 'button');
                  void confirmFilterPrint();
                }}
                disabled={isBusy || !filterPreviewDataUrl}
              >
                <span className="filter-print-button-inner">
                  <span className="filter-print-button-label">Print Now</span>
                  {filterCountdown !== null && (
                    <span className="filter-countdown" aria-label={`Auto-print in ${filterCountdown} seconds`}>
                      {filterCountdown}
                    </span>
                  )}
                </span>
              </KioskButton>
            </div>
          </div>
        </section>
      )}

      {step === 'thanks' && (
        <section className="thanks-screen">
          <div className="thanks-top-actions">
            {phoneSubmitted && !isFinalPreparing && (
              <KioskButton
                className="thanks-restart-button"
                onPress={() => {
                  void playAudioCue(settings, 'button');
                  resetGuestSession();
                }}
              >
                Restart
              </KioskButton>
            )}
          </div>
          {phoneSubmitted && (printedPreview || isAiGenerating || isFinalPreparing) && (
            <div className={`thanks-preview ${isAiGenerating || isFinalPreparing ? 'generating' : ''}${!printedPreview && isFinalPreparing ? ' loading' : ''}`}>
              {printedNumber && <p className="thanks-photo-number">Photo# {printedNumber}</p>}
              {printedPreview && <img src={printedPreview} alt="Printed layout preview" />}
              {!printedPreview && isFinalPreparing && <div className="thanks-spinner" aria-hidden="true" />}
              {!printedPreview && isFinalPreparing ? <span>PRINTING AND UPLOADING</span> : isAiGenerating && <span>GENERATING</span>}
            </div>
          )}
          <div className="thanks-content">
            {!phoneSubmitted ? (
              <>
                <p className="thanks-copy">Enter your phone # to view / download your photo at <span className="thanks-site">vibobooth.com</span>.</p>
                <div className="phone-entry-display">{formatPhoneNumber(phoneNumber) || 'Phone number'}</div>
                <DigitKeypad
                  className="phone-keypad"
                  disabled={isBusy}
                  value={phoneNumber}
                  onDigit={appendPhoneDigit}
                  onClear={() => {
                    setPhoneNumber('');
                    setPhoneEntryMessage('');
                  }}
                  onBackspace={() => {
                    setPhoneEntryMessage('');
                    setPhoneNumber((current) => current.slice(0, -1));
                  }}
                />
                <div className="phone-consent-list">
                  <label className="phone-consent-row">
                    <input
                      type="checkbox"
                      checked={galleryConsent}
                      onChange={(event) => {
                        setGalleryConsent(event.target.checked);
                        setPhoneEntryMessage('');
                      }}
                      disabled={isBusy}
                    />
                    <span>I agree to use phone number to access my photo gallery</span>
                  </label>
                  {/* <label className="phone-consent-row">
                    <input
                      type="checkbox"
                      checked={marketingConsent}
                      onChange={(event) => {
                        setMarketingConsent(event.target.checked);
                        setPhoneEntryMessage('');
                      }}
                      disabled={isBusy}
                    />
                    <span>I agree to receive promotional texts from Stephanie Wong. I can unsubscribe anytime.</span>
                  </label> */}
                </div>
                <div className="phone-action-row">
                  <KioskButton
                    className="booth-button"
                    onPress={submitPhoneNumber}
                    disabled={
                      isBusy ||
                      phoneNumber.replace(/\D/g, '').length < 7 ||
                      (!galleryConsent && !marketingConsent)
                    }
                  >
                    Submit
                  </KioskButton>
                  <KioskButton
                    className="booth-button"
                    onPress={skipPhoneEntry}
                    disabled={isBusy}
                  >
                    Skip
                  </KioskButton>
                </div>
                {phoneEntryMessage && <p className="phone-entry-message">{phoneEntryMessage}</p>}
              </>
            ) : (
              <>
                <p className="brand">THANK YOU!</p>
                <p className="thanks-copy">
                  {isFinalPreparing
                    ? 'Printing and uploading. Your photo will appear here when it is ready.'
                    : galleryQrDataUrl
                    ? <>Scan the QR code to open your photo, or find it later at <span className="thanks-site">vibobooth.com</span> with your phone number.</>
                    : 'Your photo has been saved.'}
                </p>
                {galleryQrDataUrl && (
                  <div className="gallery-qr-card">
                    <img src={galleryQrDataUrl} alt="Gallery QR code" />
                  </div>
                )}
                {thankYouCountdown !== null && thankYouCountdown > 0 && (
                  <div className="thanks-countdown" aria-label={`Returning in ${thankYouCountdown} seconds`}>
                    {thankYouCountdown}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {error && <p className="guest-error">{error}</p>}
    </GuestShell>
    </GuestScreenLockProvider>
  );
}

function DigitKeypad({
  className = '',
  disabled,
  value,
  onDigit,
  onBackspace,
  onClear
}: {
  className?: string;
  disabled?: boolean;
  value: string;
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}) {
  return (
    <div className={`queue-keypad${className ? ` ${className}` : ''}`}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
        <KioskButton key={digit} onPress={() => onDigit(digit)} disabled={disabled}>
          {digit}
        </KioskButton>
      ))}
      <KioskButton onPress={onClear} disabled={disabled || !value}>Clear</KioskButton>
      <KioskButton onPress={() => onDigit('0')} disabled={disabled}>
        0
      </KioskButton>
      <KioskButton onPress={onBackspace} disabled={disabled || !value}>Back</KioskButton>
    </div>
  );
}

function QueueEntryScreen({
  settings,
  snapshot,
  code,
  message,
  isBusy,
  onDigit,
  onBackspace,
  onClear,
  onSubmit
}: {
  settings: AppSettings;
  snapshot: QueueSnapshot | null;
  code: string;
  message: string;
  isBusy: boolean;
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onSubmit: () => void;
}) {
  const configured = isWebQueueConfigured(settings);
  const currentNumber = snapshot?.event.current_queue_number;

  return (
    <section className="queue-screen">
      <div className="queue-status-panel">
        <p className="queue-list-title">Now serving</p>
        <div className="queue-current-number">{currentNumber ? `#${currentNumber}` : '-'}</div>
        {!configured && <p className="queue-message">Queue not connected</p>}
      </div>

      <div className="queue-keypad-panel">
        <p className="instruction">ENTER YOUR 4-DIGIT CODE</p>
        <div className="queue-code-display">{code.padEnd(4, '_')}</div>
        <DigitKeypad
          disabled={isBusy || !configured}
          value={code}
          onDigit={onDigit}
          onBackspace={onBackspace}
          onClear={onClear}
        />
        <KioskButton className="booth-button primary" onPress={onSubmit} disabled={isBusy || code.length !== 4 || !configured}>
          {buttonText(isBusy ? 'CHECKING' : 'START')}
        </KioskButton>
        {message && <p className="queue-message">{message}</p>}
      </div>
    </section>
  );
}

function GuestShell({
  children,
  flash = false,
  compactTop = false,
  thanksLayout = false,
  filterLayout = false
}: {
  children: React.ReactNode;
  flash?: boolean;
  compactTop?: boolean;
  thanksLayout?: boolean;
  filterLayout?: boolean;
}) {
  return (
    <main
      className={[
        'guest-shell',
        compactTop ? 'compact-top' : '',
        thanksLayout ? 'thanks-layout' : '',
        filterLayout ? 'filter-layout' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
      <div className={`flash ${flash ? 'active' : ''}`} />
    </main>
  );
}

function TemplateMini({ layout }: { layout: TemplateLayout }) {
  const normalized = normalizeTemplateLayoutForClient(layout);
  return (
    <div className={`template-mini ${normalized.orientation}`}>
      {normalized.photoWindows.map((slot, index) => (
        <span
          key={`${slot.x}-${slot.y}-${index}`}
          style={{
            left: `${(slot.x / normalized.paperWidth) * 100}%`,
            top: `${(slot.y / normalized.paperHeight) * 100}%`,
            width: `${(slot.width / normalized.paperWidth) * 100}%`,
            height: `${(slot.height / normalized.paperHeight) * 100}%`
          }}
        />
      ))}
    </div>
  );
}

function TemplateImagePreview({ design }: { design: TemplateDesign }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    void window.photoBooth
      .getImageDataUrl(templatePreviewPath(design))
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {
        if (active) setSrc('');
      });
    return () => {
      active = false;
    };
  }, [design.previewPath, design.framePath, design.filePath]);

  return <div className="design-preview">{src ? <img src={src} alt={design.name} /> : null}</div>;
}

function FaceAssetPackPreview({ pack }: { pack: FaceAssetPack }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    if (!pack.guestPreviewPath) {
      setSrc('');
      return undefined;
    }
    void window.photoBooth
      .getImageDataUrl(pack.guestPreviewPath)
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {
        if (active) setSrc('');
      });
    return () => {
      active = false;
    };
  }, [pack.guestPreviewPath]);

  return <div className="design-preview">{src ? <img src={src} alt={pack.name} /> : null}</div>;
}

function ImagePathThumb({ path, label }: { path: string; label: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    if (!path) {
      setSrc('');
      return undefined;
    }
    void window.photoBooth
      .getImageDataUrl(path)
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {
        if (active) setSrc('');
      });
    return () => {
      active = false;
    };
  }, [path]);
  return src ? <img src={src} alt={label} /> : <Image size={22} />;
}

function createFilterExamplePlaceholder() {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#f2c7a7');
  gradient.addColorStop(0.45, '#b8d7ff');
  gradient.addColorStop(1, '#222');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.beginPath();
  ctx.arc(450, 360, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(270, 560, 360, 120);
  return canvas.toDataURL('image/png');
}

function ColorFilterStudio({
  settings,
  selectedPreset,
  selectedPresetId,
  onSelect,
  onSavePreset,
  onAddPreset,
  onDuplicatePreset,
  onDeletePreset,
  onUploadThumbnail,
  onUploadExample,
  onGenerateAllThumbnails,
  onGenerateThumbnail,
  onSaveSettings
}: {
  settings: AppSettings;
  selectedPreset: ColorFilterPreset | null;
  selectedPresetId: string;
  onSelect: (presetId: string) => void;
  onSavePreset: (preset: ColorFilterPreset, text?: string) => Promise<void>;
  onAddPreset: () => Promise<void>;
  onDuplicatePreset: (preset: ColorFilterPreset) => Promise<void>;
  onDeletePreset: (presetId: string) => Promise<void>;
  onUploadThumbnail: (presetId: string) => Promise<void>;
  onUploadExample: () => Promise<void>;
  onGenerateAllThumbnails: (exampleDataUrl: string) => Promise<void>;
  onGenerateThumbnail: (exampleDataUrl: string, preset: ColorFilterPreset) => Promise<void>;
  onSaveSettings: (partial: Partial<AppSettings>, text?: string) => Promise<AppSettings>;
}) {
  const [exampleSrc, setExampleSrc] = useState('');
  const [previewSrc, setPreviewSrc] = useState('');

  useEffect(() => {
    let active = true;
    if (!settings.template.colorFilterExamplePath) {
      setExampleSrc(createFilterExamplePlaceholder());
      return undefined;
    }
    void window.photoBooth
      .getImageDataUrl(settings.template.colorFilterExamplePath)
      .then((dataUrl) => {
        if (active) setExampleSrc(dataUrl);
      })
      .catch(() => {
        if (active) setExampleSrc(createFilterExamplePlaceholder());
      });
    return () => {
      active = false;
    };
  }, [settings.template.colorFilterExamplePath]);

  useEffect(() => {
    let active = true;
    if (!exampleSrc || !selectedPreset) {
      setPreviewSrc(exampleSrc);
      return undefined;
    }
    void applyPhotoFilters(exampleSrc, selectedPreset, 0)
      .then((dataUrl) => {
        if (active) setPreviewSrc(dataUrl);
      })
      .catch(() => {
        if (active) setPreviewSrc(exampleSrc);
      });
    return () => {
      active = false;
    };
  }, [exampleSrc, selectedPreset]);

  const updateFilterValue = (key: keyof ColorFilterValues, value: number) => {
    if (!selectedPreset) return;
    void onSavePreset({
      ...selectedPreset,
      filter: {
        ...selectedPreset.filter,
        [key]: value
      }
    });
  };

  return (
    <div className="color-filter-studio">
      <div className="color-filter-layout">
        <aside className="color-filter-preview-panel">
          <div className="color-filter-preview">
            {previewSrc && <img src={previewSrc} alt="Color filter preview" />}
          </div>
          <div className="color-filter-settings">
            <div className="admin-actions">
              <button onClick={() => void onUploadExample()}>Upload example</button>
              <button disabled={!exampleSrc} onClick={() => void onGenerateAllThumbnails(exampleSrc)}>Generate all buttons</button>
            </div>
            <div className="compact-settings-grid">
              <label>
                Countdown
                <input
                  type="number"
                  min="5"
                  max="120"
                  step="1"
                  value={Math.round(settings.beautyFilter.previewTimeoutMs / 1000)}
                  onChange={(event) =>
                    void onSaveSettings({
                      beautyFilter: {
                        ...settings.beautyFilter,
                        previewTimeoutMs: Math.max(5, Number(event.target.value || 30)) * 1000
                      }
                    }, 'Filter countdown saved.')
                  }
                />
              </label>
              <label>
                Beauty
                <select
                  value={settings.beautyFilter.enabledMode}
                  onChange={(event) =>
                    void onSaveSettings({
                      beautyFilter: {
                        ...settings.beautyFilter,
                        enabledMode: event.target.value as AppSettings['beautyFilter']['enabledMode']
                      }
                    }, 'Beauty mode saved.')
                  }
                >
                  <option value="off">Off</option>
                  <option value="print">Print only</option>
                  <option value="live">Live + Print</option>
                </select>
              </label>
            </div>
          </div>
        </aside>

        <section className="color-filter-editor">
          <div className="color-filter-list">
            <div className="admin-actions">
              <button onClick={() => void onAddPreset()}>Add preset</button>
            </div>
            <div className="color-filter-preset-strip">
              {settings.template.colorFilterPresets.map((preset) => (
                <button
                  key={preset.id}
                  className={preset.id === selectedPresetId ? 'active' : ''}
                  onClick={() => onSelect(preset.id)}
                >
                  <ImagePathThumb path={preset.thumbnailPath} label={preset.name} />
                  <span>{preset.name}</span>
                </button>
              ))}
            </div>
          </div>

          {selectedPreset ? (
            <div className="workflow-shot color-filter-edit-card">
              <div className="color-filter-edit-header">
                <label>
                  Name
                  <input
                    value={selectedPreset.name}
                    onChange={(event) => void onSavePreset({ ...selectedPreset, name: event.target.value })}
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={selectedPreset.active}
                    onChange={(event) => void onSavePreset({ ...selectedPreset, active: event.target.checked })}
                  />
                  Active
                </label>
              </div>
              <div className="color-thumbnail-row">
                <div className="color-thumbnail-preview">
                  <ImagePathThumb path={selectedPreset.thumbnailPath} label={selectedPreset.name} />
                </div>
                <div className="admin-actions">
                  <button onClick={() => void onUploadThumbnail(selectedPreset.id)}>Upload square button image</button>
                  <button disabled={!exampleSrc} onClick={() => void onGenerateThumbnail(exampleSrc, selectedPreset)}>Update button image</button>
                  <button onClick={() => void onSavePreset({ ...selectedPreset, filter: neutralColorFilterValues() }, 'Color filter reset.')}>Reset</button>
                  <button onClick={() => void onDuplicatePreset(selectedPreset)}>Duplicate</button>
                  <button className="danger" onClick={() => void onDeletePreset(selectedPreset.id)}>Delete</button>
                </div>
              </div>
              <div className="color-slider-grid">
                {COLOR_FILTER_FIELDS.map((field) => (
                  <label key={field.key} className="color-slider">
                    <span>{field.label}</span>
                    <input
                      type="range"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={selectedPreset.filter[field.key]}
                      onChange={(event) => updateFilterValue(field.key, Number(event.target.value))}
                    />
                    <strong>{selectedPreset.filter[field.key]}</strong>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted">Create a color preset to start.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function TemplateDesignAdminCard({
  design,
  settings,
  layout,
  onSave,
  onUpdateAsset,
  onDelete,
  onUploadTemplateAudioCue,
  onRemoveTemplateAudioCue,
  onGenerateTemplateCue
}: {
  design: TemplateDesign;
  settings: AppSettings;
  layout: TemplateLayout;
  onSave: (design: TemplateDesign) => Promise<void>;
  onUpdateAsset: (design: TemplateDesign, role: 'preview' | 'frame') => Promise<void>;
  onDelete: (design: TemplateDesign) => Promise<void>;
  onUploadTemplateAudioCue: (cue: AudioCue) => Promise<AudioCue>;
  onRemoveTemplateAudioCue: (cue: AudioCue) => Promise<AudioCue>;
  onGenerateTemplateCue: (cue: AudioCue, playAfterGenerate?: boolean) => Promise<AudioCue>;
}) {
  const workflow = workflowForDesign(layout, design);
  return (
    <article className="template-design-admin">
      <TemplateImagePreview design={design} />
      <input
        value={design.name}
        onChange={(event) => void onSave({ ...design, name: event.target.value })}
      />
      <label className="check-row">
        <input
          type="checkbox"
          checked={design.active}
          onChange={(event) => void onSave({ ...design, active: event.target.checked })}
        />
        Active
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={design.usesAi}
          onChange={(event) => void onSave({ ...design, usesAi: event.target.checked })}
        />
        AI frame
      </label>
      {design.usesAi && (
        <label>
          AI preset
          <select
            value={design.aiPresetId}
            onChange={(event) => void onSave({ ...design, aiPresetId: event.target.value })}
          >
            <option value="">Choose preset</option>
            {settings.template.aiPresets
              .filter((preset) => preset.active)
              .map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
          </select>
        </label>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={design.videoRecordingEnabled}
          onChange={(event) => void onSave({ ...design, videoRecordingEnabled: event.target.checked })}
        />
        Record session video
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={Boolean(design.workflowOverrideEnabled)}
          onChange={(event) =>
            void onSave({
              ...design,
              workflowOverrideEnabled: event.target.checked,
              workflowOverride: event.target.checked ? workflow : undefined
            })
          }
        />
        Override workflow
      </label>
      {design.workflowOverrideEnabled && (
        <TemplateWorkflowEditor
          workflow={workflow}
          shotCount={normalizePhotosToTake(layout.photosToTake, layout.photoWindows.length)}
          cueScopeId={`design-${design.id}`}
          settings={settings}
          onChange={(workflowOverride) => void onSave({ ...design, workflowOverride })}
          onUploadCue={onUploadTemplateAudioCue}
          onRemoveCue={onRemoveTemplateAudioCue}
          onGenerateCue={onGenerateTemplateCue}
        />
      )}
      <div className="template-path-note">
        <span>Preview: {shortPath(templatePreviewPath(design))}</span>
        <span>Print frame: {shortPath(templateFramePath(design))}</span>
      </div>
      <div className="admin-actions">
        <button onClick={() => void onUpdateAsset(design, 'preview')}>Upload preview</button>
        <button onClick={() => void onUpdateAsset(design, 'frame')}>Upload print frame</button>
        <button onClick={() => window.photoBooth.openFile(templateFramePath(design))}>Open frame</button>
        <button className="danger" onClick={() => void onDelete(design)}>Delete</button>
      </div>
    </article>
  );
}

function TemplateWorkflowEditor({
  workflow,
  shotCount,
  cueScopeId,
  settings,
  onChange,
  onUploadCue,
  onRemoveCue,
  onGenerateCue
}: {
  workflow: TemplateWorkflowSettings;
  shotCount: number;
  cueScopeId: string;
  settings: AppSettings;
  onChange: (workflow: TemplateWorkflowSettings) => void;
  onUploadCue: (cue: AudioCue) => Promise<AudioCue>;
  onRemoveCue: (cue: AudioCue) => Promise<AudioCue>;
  onGenerateCue: (cue: AudioCue, playAfterGenerate?: boolean) => Promise<AudioCue>;
}) {
  const normalized = normalizeTemplateWorkflow(workflow, shotCount);
  const updateShot = (index: number, partial: Partial<TemplateWorkflowSettings['shots'][number]>) => {
    const shots = normalized.shots.map((shot, shotIndex) => (shotIndex === index ? { ...shot, ...partial } : shot));
    onChange({ ...normalized, shots });
  };
  const screenCue = (cueId: 'intro' | 'select' | 'thanks' | 'facePack') => {
    const defaults = {
      intro: defaultTemplateScreenCue(cueScopeId, 'intro', 'Intro screen voice', normalized.introMessage),
      select: defaultTemplateScreenCue(cueScopeId, 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.'),
      thanks: defaultTemplateScreenCue(cueScopeId, 'thanks', 'Finish screen voice', normalized.thankYouMessage),
      facePack: defaultTemplateScreenCue(cueScopeId, 'facePack', 'Face assets screen voice', 'Please choose your face accessories.')
    };
    return {
      ...defaults[cueId],
      ...(normalized.screenCues?.[cueId] ?? {}),
      id: normalized.screenCues?.[cueId]?.id || `${cueScopeId}-${cueId}`,
      channel: 'voice' as const
    };
  };
  const saveScreenCue = async (cueId: 'intro' | 'select' | 'thanks' | 'facePack', cue: AudioCue) => {
    onChange({
      ...normalized,
      screenCues: {
        ...normalized.screenCues,
        [cueId]: { ...cue, updatedAt: new Date().toISOString() }
      }
    });
  };
  const shotCue = (shot: TemplateWorkflowSettings['shots'][number], index: number) => ({
    ...defaultTemplateShotAudioCue(cueScopeId, index, shot.message),
    ...(shot.audioCue ?? {}),
    id: shot.audioCue?.id || `${cueScopeId}-shot-${index}`,
    label: `Picture ${index + 1} voice`,
    channel: 'voice' as const,
    text: shot.audioCue?.text ?? shot.message
  });
  const saveShotCue = async (index: number, cue: AudioCue) => {
    updateShot(index, { audioCue: { ...cue, updatedAt: new Date().toISOString() } });
  };
  return (
    <div className="workflow-shot template-workflow-panel">
      <h2>Template workflow</h2>
      <div className="workflow-grid">
        <label>
          Intro message
          <input
            value={normalized.introMessage}
            onChange={(event) =>
              onChange({
                ...normalized,
                introMessage: event.target.value,
                screenCues: {
                  ...normalized.screenCues,
                  intro: { ...screenCue('intro'), text: event.target.value }
                }
              })
            }
          />
        </label>
        <label>
          Intro seconds
          <input type="number" min="0" step="0.5" value={msToSeconds(normalized.introMs)} onChange={(event) => onChange({ ...normalized, introMs: secondsToMs(event.target.value) })} />
        </label>
        <label>
          Auto print seconds
          <input type="number" min="0" step="1" value={msToSeconds(normalized.printAutoSelectMs)} onChange={(event) => onChange({ ...normalized, printAutoSelectMs: secondsToMs(event.target.value) })} />
        </label>
        <label>
          Thank you seconds
          <input type="number" min="1" step="0.5" value={msToSeconds(normalized.thankYouMs)} onChange={(event) => onChange({ ...normalized, thankYouMs: secondsToMs(event.target.value) })} />
        </label>
      </div>
      <label>
        Thank you message
        <input
          value={normalized.thankYouMessage}
          onChange={(event) =>
            onChange({
              ...normalized,
              thankYouMessage: event.target.value,
              screenCues: {
                ...normalized.screenCues,
                thanks: { ...screenCue('thanks'), text: event.target.value }
              }
            })
          }
        />
      </label>
      <div className="audio-cue-group template-screen-cues">
        <h2>Screen voice</h2>
        <div className="audio-cue-grid">
          {(['intro', 'select', 'thanks', 'facePack'] as const).map((cueId) => {
            const cue = screenCue(cueId);
            return (
              <AudioCueCard
                key={cueId}
                cue={cue}
                settings={settings}
                onSave={(updatedCue) => saveScreenCue(cueId, updatedCue)}
                onUpload={async () => saveScreenCue(cueId, await onUploadCue(cue))}
                onRemove={async () => saveScreenCue(cueId, await onRemoveCue(cue))}
                onGenerate={async (_cueId, playAfterGenerate) => saveScreenCue(cueId, await onGenerateCue(cue, playAfterGenerate))}
                onTest={(updatedCue) => updatedCue.mode === 'host' && !updatedCue.filePath ? void onGenerateCue(updatedCue, true).then((generated) => saveScreenCue(cueId, generated)) : playAudioCueObject(settings, updatedCue)}
              />
            );
          })}
        </div>
      </div>
      <div className="workflow-shots compact">
        {normalized.shots.map((shot, index) => (
          <div className="workflow-shot" key={index}>
            <h2>Picture {index + 1}</h2>
            <label>
              Message
              <input
                value={shot.message}
                onChange={(event) => {
                  const cue = shotCue(shot, index);
                  updateShot(index, { message: event.target.value, audioCue: { ...cue, text: event.target.value } });
                }}
              />
            </label>
            <div className="workflow-grid">
              <label>
                Camera before message
                <input type="number" min="0" step="0.5" value={msToSeconds(shot.cameraBeforeMessageMs)} onChange={(event) => updateShot(index, { cameraBeforeMessageMs: secondsToMs(event.target.value) })} />
              </label>
              <label>
                Message time
                <input type="number" min="0" step="0.5" value={msToSeconds(shot.messageMs)} onChange={(event) => updateShot(index, { messageMs: secondsToMs(event.target.value) })} />
              </label>
              <label>
                Camera before countdown
                <input type="number" min="0" step="0.5" value={msToSeconds(shot.cameraBeforeCountdownMs)} onChange={(event) => updateShot(index, { cameraBeforeCountdownMs: secondsToMs(event.target.value) })} />
              </label>
            </div>
            <AudioCueCard
              cue={shotCue(shot, index)}
              settings={settings}
              onSave={(cue) => saveShotCue(index, cue)}
              onUpload={async () => saveShotCue(index, await onUploadCue(shotCue(shot, index)))}
              onRemove={async () => saveShotCue(index, await onRemoveCue(shotCue(shot, index)))}
              onGenerate={async (_cueId, playAfterGenerate) => saveShotCue(index, await onGenerateCue(shotCue(shot, index), playAfterGenerate))}
              onTest={(cue) => cue.mode === 'host' && !cue.filePath ? void onGenerateCue(cue, true).then((updated) => saveShotCue(index, updated)) : playAudioCueObject(settings, cue, shot.message)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateCreator({
  initialLayout,
  onCancel,
  onSave
}: {
  initialLayout: TemplateLayout;
  onCancel: () => void;
  onSave: (layout: TemplateLayout) => void;
}) {
  const [layout, setLayout] = useState(() => normalizeTemplateLayoutForClient(initialLayout));
  const [drag, setDrag] = useState<null | {
    id: number;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    slot: TemplateSlot;
  }>(null);
  const paperRef = useRef<HTMLDivElement>(null);

  const updateWindows = (updater: (windows: TemplateSlot[]) => TemplateSlot[]) => {
    setLayout((current) => {
      const photoWindows = updater(current.photoWindows).map((slot, index) => ({ ...slot, sourceIndex: index }));
      return normalizeTemplateLayoutForClient({
        ...current,
        photoWindows,
        workflowDefaults: normalizeTemplateWorkflow(current.workflowDefaults, photoWindows.length),
        updatedAt: new Date().toISOString()
      });
    });
  };

  const rotatePaper = () => {
    setLayout((current) => {
      const nextOrientation = current.orientation === 'portrait' ? 'landscape' : 'portrait';
      const dimensions = templateDimensions(nextOrientation);
      const ratioX = dimensions.width / current.paperWidth;
      const ratioY = dimensions.height / current.paperHeight;
      return normalizeTemplateLayoutForClient({
        ...current,
        orientation: nextOrientation,
        paperWidth: dimensions.width,
        paperHeight: dimensions.height,
        photoWindows: current.photoWindows.map((slot) => ({
          ...slot,
          x: slot.x * ratioX,
          y: slot.y * ratioY,
          width: slot.width * ratioX,
          height: slot.height * ratioY
        }))
      });
    });
  };

  const addWindow = () => {
    updateWindows((windows) => {
      const width = layout.paperWidth / 3;
      const height = width * 2 / 3;
      return [
        ...windows,
        {
          x: (layout.paperWidth - width) / 2,
          y: (layout.paperHeight - height) / 2,
          width,
          height,
          sourceIndex: windows.length,
          rotation: 0
        }
      ];
    });
  };

  const duplicateWindow = (index: number) => {
    updateWindows((windows) => {
      const source = windows[index];
      if (!source) return windows;
      const offset = Math.min(layout.paperWidth, layout.paperHeight) * 0.035;
      const duplicate = {
        ...source,
        x: Math.max(0, Math.min(layout.paperWidth - source.width, source.x + offset)),
        y: Math.max(0, Math.min(layout.paperHeight - source.height, source.y + offset)),
        sourceIndex: windows.length
      };
      return [...windows.slice(0, index + 1), duplicate, ...windows.slice(index + 1)];
    });
  };

  const alignTop = () => {
    updateWindows((windows) => {
      if (windows.length < 2) return windows;
      const top = Math.min(...windows.map((slot) => slot.y));
      return windows.map((slot) => ({ ...slot, y: top }));
    });
  };

  const distributeSameGap = () => {
    updateWindows((windows) => {
      if (windows.length < 3) return windows;
      const sorted = [...windows].sort((a, b) => a.x - b.x);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const left = first.x;
      const right = last.x + last.width;
      const totalWidth = sorted.reduce((sum, slot) => sum + slot.width, 0);
      const gap = Math.max(0, (right - left - totalWidth) / (sorted.length - 1));
      let nextX = left;
      const positions = new Map<TemplateSlot, number>();
      sorted.forEach((slot) => {
        positions.set(slot, Math.max(0, Math.min(layout.paperWidth - slot.width, nextX)));
        nextX += slot.width + gap;
      });
      return windows.map((slot) => ({ ...slot, x: positions.get(slot) ?? slot.x }));
    });
  };

  const paperPoint = (event: React.PointerEvent) => {
    const rect = paperRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * layout.paperWidth,
      y: ((event.clientY - rect.top) / rect.height) * layout.paperHeight
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const point = paperPoint(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    updateWindows((windows) =>
      windows.map((slot, index) => {
        if (index !== drag.id) return slot;
        if (drag.mode === 'resize') {
          const width = Math.max(80, Math.min(layout.paperWidth - slot.x, drag.slot.width + dx));
          const height = Math.max(80, Math.min(layout.paperHeight - slot.y, drag.slot.height + dy));
          return { ...slot, width, height };
        }
        const x = Math.max(0, Math.min(layout.paperWidth - slot.width, drag.slot.x + dx));
        const y = Math.max(0, Math.min(layout.paperHeight - slot.height, drag.slot.y + dy));
        return { ...slot, x, y };
      })
    );
  };

  const saveDisabled = layout.name.trim().length === 0 || layout.photoWindows.length === 0;

  return (
    <div className="template-creator-overlay">
      <div className="template-creator-shell">
        <aside className="template-creator-tools">
          <label>
            Name
            <input value={layout.name} onChange={(event) => setLayout({ ...layout, name: event.target.value })} />
          </label>
          <button onClick={rotatePaper}><RotateCw size={16} />Rotate paper</button>
          <button onClick={addWindow}><Image size={16} />Add photo window</button>
          <button onClick={alignTop} disabled={layout.photoWindows.length < 2}>Align top</button>
          <button onClick={distributeSameGap} disabled={layout.photoWindows.length < 3}>Same gap</button>
          <button disabled={saveDisabled} onClick={() => onSave(normalizeTemplateLayoutForClient(layout))}>Save template</button>
          <button onClick={onCancel}>Cancel</button>
        </aside>
        <div className="template-creator-workspace">
          <div
            ref={paperRef}
            className={`template-paper ${layout.orientation}`}
            onPointerMove={onPointerMove}
            onPointerUp={() => setDrag(null)}
            onPointerLeave={() => setDrag(null)}
          >
            {layout.photoWindows.map((slot, index) => (
              <div
                key={index}
                className="template-window-box"
                style={{
                  left: `${(slot.x / layout.paperWidth) * 100}%`,
                  top: `${(slot.y / layout.paperHeight) * 100}%`,
                  width: `${(slot.width / layout.paperWidth) * 100}%`,
                  height: `${(slot.height / layout.paperHeight) * 100}%`
                }}
                onPointerDown={(event) => {
                  const point = paperPoint(event);
                  setDrag({ id: index, mode: 'move', startX: point.x, startY: point.y, slot });
                }}
              >
                <span className="template-window-number">{index + 1}</span>
                <button
                  className="template-window-rotate"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    updateWindows((windows) =>
                      windows.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              width: Math.min(item.height, layout.paperWidth - item.x),
                              height: Math.min(item.width, layout.paperHeight - item.y),
                              rotation: 0
                            }
                          : item
                      )
                    )
                  }
                >
                  <RotateCw size={14} />
                </button>
                <button
                  className="template-window-delete"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => updateWindows((windows) => windows.filter((_item, itemIndex) => itemIndex !== index))}
                >
                  <Trash2 size={14} />
                </button>
                <button
                  className="template-window-duplicate"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => duplicateWindow(index)}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="template-window-resize"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    const point = paperPoint(event);
                    setDrag({ id: index, mode: 'resize', startX: point.x, startY: point.y, slot });
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminApp() {
  const { settings, updateSettings, refreshSettings: reloadSettings } = useSettings();
  const [tab, setTab] = useState('event');
  const [gallery, setGallery] = useState<Gallery>({ originals: [], finals: [] });
  const [aiQueue, setAiQueue] = useState<AiQueueItem[]>([]);
  const [printers, setPrinters] = useState<Electron.PrinterInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [message, setMessage] = useState('');
  const [gallerySearch, setGallerySearch] = useState('');
  const [cameraCapabilities, setCameraCapabilities] = useState<CameraCapabilitiesMap>({});
  const [cameraDefaultControls, setCameraDefaultControls] = useState<CameraControlSettings>({});
  const [selectedAdminTemplateId, setSelectedAdminTemplateId] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<TemplateLayout | null>(null);
  const [selectedFaceAssetPackId, setSelectedFaceAssetPackId] = useState('');
  const [selectedColorFilterId, setSelectedColorFilterId] = useState('');
  const [aiPresetDraft, setAiPresetDraft] = useState({ name: '', prompt: '' });
  const [galleryUploadStatus, setGalleryUploadStatus] = useState<GalleryUploadStatus>({
    state: 'idle',
    message: 'No active upload.',
    active: 0
  });
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const [adminStream, setAdminStream] = useState<MediaStream | null>(null);

  const refreshGallery = async () => setGallery(await window.photoBooth.listGallery());
  const refreshAiQueue = async () => setAiQueue(await window.photoBooth.listAiQueue());
  const refreshPrinters = async () => setPrinters(await window.photoBooth.listPrinters());
  const refreshCameras = async () => {
    let permissionStream: MediaStream | null = null;
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((device) => device.kind === 'videoinput'));
    } catch {
      setMessage('Camera permission is needed to list cameras.');
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop());
    }
  };

  useEffect(() => {
    void refreshGallery();
    void refreshAiQueue();
    void refreshPrinters();
    void refreshCameras();
    void window.photoBooth.getGalleryUploadStatus().then(setGalleryUploadStatus);
    return window.photoBooth.onGalleryUploadStatus((status) => {
      setGalleryUploadStatus(status);
      if (status.state === 'done' || status.state === 'failed') void refreshGallery();
    });
  }, []);

  useEffect(() => {
    if (tab === 'gallery') void refreshGallery();
    if (tab === 'aiQueue') void refreshAiQueue();
  }, [tab]);

  useEffect(() => {
    if (!settings) return;
    const packs = settings.template.faceAssetPacks;
    if (packs.length > 0 && !packs.some((pack) => pack.id === selectedFaceAssetPackId)) {
      setSelectedFaceAssetPackId(packs[0].id);
    }
    if (packs.length === 0 && selectedFaceAssetPackId) setSelectedFaceAssetPackId('');
  }, [settings?.template.faceAssetPacks, selectedFaceAssetPackId]);

  useEffect(() => {
    if (!settings) return;
    const presets = settings.template.colorFilterPresets;
    if (presets.length > 0 && !presets.some((preset) => preset.id === selectedColorFilterId)) {
      setSelectedColorFilterId(presets[0].id);
    }
    if (presets.length === 0 && selectedColorFilterId) setSelectedColorFilterId('');
  }, [settings?.template.colorFilterPresets, selectedColorFilterId]);

  useEffect(() => {
    if (tab !== 'aiQueue') return undefined;
    const timer = window.setInterval(() => {
      void refreshAiQueue();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'camera' || !settings) return undefined;
    let stream: MediaStream | null = null;
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: settings.cameraId ? { deviceId: { exact: settings.cameraId } } : true,
          audio: false
        });
        setCameraDefaultControls(getCameraControlSettings(stream));
        await applyCameraControls(stream, settings.cameraControls);
        setCameraCapabilities(getCameraCapabilities(stream));
        setAdminStream(stream);
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = stream;
          await cameraPreviewRef.current.play();
        }
      } catch {
        setMessage('Camera preview failed.');
      }
    };
    void start();
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
      setAdminStream(null);
      setCameraCapabilities({});
      setCameraDefaultControls({});
    };
  }, [settings?.cameraId, tab]);

  const selectedFaceAssetPack = settings?.template.faceAssetPacks.find((pack) => pack.id === selectedFaceAssetPackId) ?? null;
  const selectedColorFilter = settings?.template.colorFilterPresets.find((preset) => preset.id === selectedColorFilterId) ?? null;

  const latestFinal = useMemo(() => gallery.finals[0], [gallery]);
  const filteredFinals = useMemo(() => {
    const query = gallerySearch.trim().toLowerCase();
    if (!query) return gallery.finals;
    return gallery.finals.filter((photo) => photoNumber(photo.name).includes(query) || photo.name.toLowerCase().includes(query));
  }, [gallery.finals, gallerySearch]);

  if (!settings) return <main className="admin-shell"><p>Loading</p></main>;

  const saveMessage = async (partial: Partial<AppSettings>, text = 'Saved.') => {
    const next = await updateSettings(partial);
    setMessage(text);
    window.setTimeout(() => setMessage(''), 2200);
    return next;
  };

  const saveAudioSettings = async (audio: AppSettings['audio'], text = 'Audio saved.') => {
    const next = await saveMessage({ audio }, text);
    return next.audio;
  };

  const saveAudioCue = async (cue: AudioCue, text = 'Audio cue saved.') => {
    await saveAudioSettings(
      {
        ...settings.audio,
        cues: {
          ...settings.audio.cues,
          [cue.id]: { ...cue, updatedAt: new Date().toISOString() }
        }
      },
      text
    );
  };

  const uploadAudioCue = async (cueId: string) => {
    try {
      const next = await window.photoBooth.uploadAudioCue(cueId);
      await updateSettings(next);
      setMessage('Audio file uploaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Audio upload failed.');
    }
  };

  const removeAudioCue = async (cueId: string) => {
    const next = await window.photoBooth.removeAudioCue(cueId);
    await updateSettings(next);
    setMessage('Audio file removed.');
  };

  const generateHostVoiceCue = async (cueId: string, playAfterGenerate = false) => {
    setMessage('Generating host voice...');
    const result = await window.photoBooth.generateHostVoiceCue(cueId);
    await updateSettings(result.settings);
    if (!result.ok) {
      setMessage(result.error ?? 'Host voice generation failed.');
      return;
    }
    setMessage('Host voice generated.');
    if (playAfterGenerate) void playAudioCue(result.settings, cueId);
  };

  const generateAllHostVoiceCues = async () => {
    setMessage('Generating all host voice lines...');
    const result = await window.photoBooth.generateAllHostVoiceCues();
    await updateSettings(result.settings);
    setMessage(result.ok ? 'All host voice lines generated.' : result.error ?? 'Host voice generation failed.');
  };

  const uploadTemplateAudioCue = async (cue: AudioCue) => {
    const updated = await window.photoBooth.uploadTemplateAudioCue(cue);
    if (!updated) return cue;
    setMessage('Template audio uploaded.');
    return updated;
  };

  const removeTemplateAudioCue = async (cue: AudioCue) => {
    const updated = await window.photoBooth.removeTemplateAudioCue(cue);
    setMessage('Template audio cleared.');
    return updated;
  };

  const generateTemplateHostVoiceCue = async (cue: AudioCue, playAfterGenerate = false) => {
    setMessage('Generating template host voice...');
    const result = await window.photoBooth.generateTemplateHostVoiceCue(cue);
    if (!result.ok || !result.cue) {
      setMessage(result.error ?? 'Host voice generation failed.');
      return cue;
    }
    setMessage('Template host voice generated.');
    if (playAfterGenerate) void playAudioCueObject(settings, result.cue);
    return result.cue;
  };

  const saveCameraControl = async (key: CameraControlKey, value: number) => {
    const cameraControls = { ...settings.cameraControls, [key]: value };
    await saveMessage({ cameraControls }, 'Camera control saved.');
    if (adminStream) void applyCameraControls(adminStream, cameraControls);
  };

  const resetCameraControls = async () => {
    const defaults = getManualCameraDefaults(cameraCapabilities);
    await saveMessage({ cameraControls: defaults }, 'Camera controls reset.');
    if (adminStream) void applyCameraControls(adminStream, defaults);
  };

  const restartAdminCameraPreview = async () => {
    adminStream?.getTracks().forEach((track) => track.stop());
    setAdminStream(null);
    setCameraCapabilities({});
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: settings.cameraId ? { deviceId: { exact: settings.cameraId } } : true,
        audio: false
      });
      setCameraDefaultControls(getCameraControlSettings(stream));
      setCameraCapabilities(getCameraCapabilities(stream));
      setAdminStream(stream);
      if (cameraPreviewRef.current) {
        cameraPreviewRef.current.srcObject = stream;
        await cameraPreviewRef.current.play();
      }
    } catch {
      setMessage('Camera preview failed.');
    }
  };

  const saveTemplateDesign = async (design: TemplateDesign) => {
    const updated = await window.photoBooth.updateTemplate(design);
    await saveMessage(
      {
        template: {
          ...settings.template,
          designs: settings.template.designs.map((item) => (item.id === design.id ? updated : item))
        }
      },
      'Template saved.'
    );
  };

  const refreshSettings = async () => {
    await updateSettings({});
  };

  const saveTemplateLayout = async (layout: TemplateLayout) => {
    const next = await window.photoBooth.updateTemplateLayout(layout);
    await updateSettings(next);
    setSelectedAdminTemplateId(layout.id);
    setEditingTemplate(null);
    setMessage('Template saved.');
  };

  const deleteTemplateLayout = async (templateId: string) => {
    const next = await window.photoBooth.deleteTemplateLayout(templateId);
    await updateSettings(next);
    setSelectedAdminTemplateId(next.template.layouts[0]?.id ?? '');
    setMessage('Template deleted.');
  };

  const importTemplate = async () => {
    try {
      const next = await window.photoBooth.importTemplate();
      await updateSettings(next);
      setSelectedAdminTemplateId(next.template.selectedTemplateId || next.template.layouts[0]?.id || '');
      setMessage('Template imported.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Template import failed.');
    }
  };

  const exportTemplate = async (templateId: string) => {
    try {
      const result = await window.photoBooth.exportTemplate(templateId);
      setMessage(result.ok ? `Template exported: ${result.filePath}` : 'Template export canceled.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Template export failed.');
    }
  };

  const uploadTemplate = async (templateId: string) => {
    try {
      const design = await window.photoBooth.uploadTemplate({ templateId });
      if (design) {
        await refreshSettings();
        setMessage('Template uploaded.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Template upload failed.');
    }
  };

  const deleteTemplateDesign = async (design: TemplateDesign) => {
    await window.photoBooth.deleteTemplate(design.id);
    await refreshSettings();
    setMessage('Template deleted.');
  };

  const updateTemplateAsset = async (design: TemplateDesign, role: 'preview' | 'frame') => {
    try {
      const updated = await window.photoBooth.updateTemplateAsset(design.id, role);
      if (!updated) return;
      await refreshSettings();
      setMessage(role === 'preview' ? 'Preview image updated.' : 'Print frame updated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Template asset failed.');
    }
  };

  const saveGuide = async (layout: TemplateLayout) => {
    const dataUrl = await createGuideTemplateImage(layout, settings.printCalibration);
    const filePath = await window.photoBooth.saveGuideTemplate(layout.id, dataUrl);
    setMessage(`Guide saved: ${filePath}`);
  };

  const addFaceAssetPack = async () => {
    const now = new Date().toISOString();
    const pack: FaceAssetPack = {
      id: `face-pack-${Date.now()}`,
      name: 'Face Asset Pack',
      active: true,
      assignPerFace: false,
      guestPreviewPath: '',
      assets: [],
      createdAt: now,
      updatedAt: now
    };
    const next = await window.photoBooth.updateFaceAssetPack(pack);
    await updateSettings(next);
    setSelectedFaceAssetPackId(pack.id);
    setMessage('Face asset pack saved.');
  };

  const saveFaceAssetPack = async (pack: FaceAssetPack) => {
    const next = await window.photoBooth.updateFaceAssetPack({ ...pack, updatedAt: new Date().toISOString() });
    await updateSettings(next);
    setMessage('Face asset pack saved.');
  };

  const deleteFaceAssetPack = async (packId: string) => {
    const next = await window.photoBooth.deleteFaceAssetPack(packId);
    await updateSettings(next);
    setSelectedFaceAssetPackId(next.template.faceAssetPacks[0]?.id ?? '');
    setMessage('Face asset pack deleted.');
  };

  const uploadFaceAsset = async (packId: string) => {
    try {
      const next = await window.photoBooth.uploadFaceAsset(packId);
      await updateSettings(next);
      setMessage('Face asset uploaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Face asset upload failed.');
    }
  };

  const uploadFaceAssetPackPreview = async (packId: string) => {
    try {
      const next = await window.photoBooth.uploadFaceAssetPackPreview(packId);
      await updateSettings(next);
      setMessage('Guest preview uploaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Guest preview upload failed.');
    }
  };

  const removeFaceAsset = async (packId: string, assetId: string) => {
    const next = await window.photoBooth.removeFaceAsset(packId, assetId);
    await updateSettings(next);
    setMessage('Face asset removed.');
  };

  const addAiPreset = async () => {
    const now = new Date().toISOString();
    const preset: AiPreset = {
      id: `ai-${Date.now()}`,
      name: aiPresetDraft.name.trim() || 'AI Preset',
      prompt: aiPresetDraft.prompt,
      referenceImages: [],
      active: true,
      createdAt: now,
      updatedAt: now
    };
    await saveMessage({ template: { ...settings.template, aiPresets: [...settings.template.aiPresets, preset] } }, 'AI preset saved.');
    setAiPresetDraft({ name: '', prompt: '' });
  };

  const saveAiPreset = async (preset: AiPreset) => {
    const aiPresets = settings.template.aiPresets.map((item) =>
      item.id === preset.id ? { ...preset, updatedAt: new Date().toISOString() } : item
    );
    await saveMessage({ template: { ...settings.template, aiPresets } }, 'AI preset saved.');
  };

  const deleteAiPreset = async (presetId: string) => {
    const aiPresets = settings.template.aiPresets.filter((item) => item.id !== presetId);
    const designs = settings.template.designs.map((design) =>
      design.aiPresetId === presetId ? { ...design, usesAi: false, aiPresetId: '', updatedAt: new Date().toISOString() } : design
    );
    await saveMessage({ template: { ...settings.template, aiPresets, designs } }, 'AI preset deleted.');
  };

  const uploadAiPresetImage = async (presetId: string) => {
    const next = await window.photoBooth.uploadAiPresetImage(presetId);
    await updateSettings(next);
    setMessage('AI image added.');
  };

  const removeAiPresetImage = async (presetId: string, imageId: string) => {
    const next = await window.photoBooth.removeAiPresetImage(presetId, imageId);
    await updateSettings(next);
    setMessage('AI image removed.');
  };

  const saveColorFilterPreset = async (preset: ColorFilterPreset, text = 'Color filter saved.') => {
    const colorFilterPresets = settings.template.colorFilterPresets.map((item) =>
      item.id === preset.id ? { ...preset, filter: normalizeColorFilterValuesForClient(preset.filter), updatedAt: new Date().toISOString() } : item
    );
    await saveMessage({ template: { ...settings.template, colorFilterPresets } }, text);
  };

  const addColorFilterPreset = async () => {
    const now = new Date().toISOString();
    const preset: ColorFilterPreset = {
      id: `color-filter-${Date.now()}`,
      name: 'New Filter',
      active: true,
      thumbnailPath: '',
      filter: neutralColorFilterValues(),
      createdAt: now,
      updatedAt: now
    };
    await saveMessage({
      template: {
        ...settings.template,
        colorFilterPresets: [...settings.template.colorFilterPresets, preset]
      }
    }, 'Color filter added.');
    setSelectedColorFilterId(preset.id);
  };

  const duplicateColorFilterPreset = async (preset: ColorFilterPreset) => {
    const now = new Date().toISOString();
    const copyPreset: ColorFilterPreset = {
      ...preset,
      id: `color-filter-${Date.now()}`,
      name: `${preset.name} Copy`,
      createdAt: now,
      updatedAt: now
    };
    await saveMessage({
      template: {
        ...settings.template,
        colorFilterPresets: [...settings.template.colorFilterPresets, copyPreset]
      }
    }, 'Color filter duplicated.');
    setSelectedColorFilterId(copyPreset.id);
  };

  const deleteColorFilterPreset = async (presetId: string) => {
    const colorFilterPresets = settings.template.colorFilterPresets.filter((preset) => preset.id !== presetId);
    await saveMessage({ template: { ...settings.template, colorFilterPresets } }, 'Color filter deleted.');
    setSelectedColorFilterId(colorFilterPresets[0]?.id ?? '');
  };

  const uploadColorFilterThumbnail = async (presetId: string) => {
    const next = await window.photoBooth.uploadColorFilterThumbnail(presetId);
    await updateSettings(next);
    setMessage('Color filter thumbnail uploaded.');
  };

  const uploadColorFilterExample = async () => {
    const next = await window.photoBooth.uploadColorFilterExample();
    await updateSettings(next);
    setMessage('Color filter example uploaded. Generating buttons...');
    if (!next.template.colorFilterExamplePath) return;
    try {
      const exampleDataUrl = await window.photoBooth.getImageDataUrl(next.template.colorFilterExamplePath);
      const thumbnails = await Promise.all(
        next.template.colorFilterPresets.map(async (preset) => ({
          presetId: preset.id,
          dataUrl: await createSquareFilterThumbnail(exampleDataUrl, preset)
        }))
      );
      const generated = await window.photoBooth.saveGeneratedColorFilterThumbnails(thumbnails);
      await updateSettings(generated);
      setMessage('Color filter buttons generated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Color filter buttons failed.');
    }
  };

  const generateAllColorFilterThumbnails = async (exampleDataUrl: string) => {
    try {
      setMessage('Generating color filter buttons...');
      const thumbnails = await Promise.all(
        settings.template.colorFilterPresets.map(async (preset) => ({
          presetId: preset.id,
          dataUrl: await createSquareFilterThumbnail(exampleDataUrl, preset)
        }))
      );
      const next = await window.photoBooth.saveGeneratedColorFilterThumbnails(thumbnails);
      await updateSettings(next);
      setMessage('Color filter buttons updated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Color filter buttons failed.');
    }
  };

  const generateColorFilterThumbnail = async (exampleDataUrl: string, preset: ColorFilterPreset) => {
    try {
      setMessage('Updating color filter button...');
      const dataUrl = await createSquareFilterThumbnail(exampleDataUrl, preset);
      const next = await window.photoBooth.saveGeneratedColorFilterThumbnails([{ presetId: preset.id, dataUrl }]);
      await updateSettings(next);
      setMessage('Color filter button updated.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Color filter button failed.');
    }
  };

  const updateAiProvider = async (provider: AiProvider, partial: Partial<AppSettings['ai']['providers'][AiProvider]>) => {
    await saveMessage({
      ai: {
        ...settings.ai,
        providers: {
          ...settings.ai.providers,
          [provider]: {
            ...settings.ai.providers[provider],
            ...partial
          }
        }
      }
    }, 'AI settings saved.');
  };

  const retryAiQueueItem = async (itemId: string) => {
    setMessage('AI retry started.');
    const retryPromise = window.photoBooth.retryAiQueueItem(itemId);
    await delay(250);
    await refreshAiQueue();
    const result = await retryPromise;
    await refreshAiQueue();
    await refreshGallery();
    setMessage(result.fallback ? 'AI retry failed.' : 'AI retry finished.');
  };

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <p className="admin-title">PHOTO BOOTH</p>
        <div className={`upload-status-pill ${galleryUploadStatus.state}`}>
          <span />
          <strong>{galleryUploadStatus.state === 'uploading' ? `Uploading ${galleryUploadStatus.active}` : galleryUploadStatus.state}</strong>
          <small>{galleryUploadStatus.message}</small>
        </div>
        {[
          ['event', 'Event', Settings],
          ['camera', 'Camera', Camera],
          ['printer', 'Printer', Printer],
          ['workflow', 'Workflow', SlidersHorizontal],
          ['template', 'Template', Image],
          ['colorFilters', 'Color Filters', SlidersHorizontal],
          ['faceAssets', 'Face Assets', Sparkles],
          ['aiPresets', 'AI Presets', Sparkles],
          ['aiQueue', 'AI Queue', RefreshCw],
          ['gallery', 'Gallery', FolderOpen]
        ].map(([id, label, Icon]) => (
          <button key={id as string} className={tab === id ? 'active' : ''} onClick={() => setTab(id as string)}>
            <Icon size={17} />
            <span>{label as string}</span>
          </button>
        ))}
      </aside>

      <section className="admin-panel">
        <header className="admin-header">
          <h1>{tab.toUpperCase()}</h1>
          {tab === 'template' && (
            <button className="admin-action" onClick={() => setTab('aiPresets')}>
              <Sparkles size={16} />AI Presets
            </button>
          )}
        </header>
        {message && <p className="admin-toast">{message}</p>}

        {tab === 'event' && (
          <AdminSection>
            <div className="admin-actions">
              <button
                onClick={async () => {
                  await window.photoBooth.openGuest();
                  setMessage('Guest window opened.');
                }}
              >
                Open guest window
              </button>
              <button
                onClick={async () => {
                  await window.photoBooth.openGuest();
                  await window.photoBooth.setGuestFullscreen(true);
                  setMessage('Guest window opened fullscreen.');
                }}
              >
                Open guest fullscreen
              </button>
              <button
                onClick={async () => {
                  await window.photoBooth.setGuestFullscreen(false);
                  setMessage('Guest fullscreen disabled.');
                }}
              >
                <Minimize2 size={16} />Exit guest fullscreen
              </button>
            </div>
            <label>
              Event name
              <input value={settings.eventName} onChange={(event) => void saveMessage({ eventName: event.target.value }, 'Event name saved.')} />
            </label>
            <label>
              Event folder
              <div className="inline-field">
                <input value={settings.eventFolder} readOnly />
                <button onClick={async () => {
                  const folder = await window.photoBooth.chooseFolder();
                  if (folder) await saveMessage({ eventFolder: folder }, 'Event folder saved.');
                  await refreshGallery();
                }}>Choose</button>
              </div>
            </label>
            <label>
              Admin password
              <input
                type="password"
                value={settings.adminPassword}
                placeholder="Optional for later"
                onChange={(event) => void saveMessage({ adminPassword: event.target.value }, 'Password saved.')}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.staffControlQueueMode}
                onChange={(event) => void saveMessage({ staffControlQueueMode: event.target.checked }, 'Queue mode saved.')}
              />
              Staff control queue mode
            </label>
            <label>
              Web API base URL
              <input
                value={settings.webApiBaseUrl}
                placeholder="http://localhost:3000"
                onChange={(event) => void saveMessage({ webApiBaseUrl: event.target.value }, 'Web API URL saved.')}
              />
            </label>
            <label>
              Supabase URL
              <input
                value={settings.supabaseUrl}
                placeholder="https://your-project.supabase.co"
                onChange={(event) => void saveMessage({ supabaseUrl: event.target.value }, 'Supabase URL saved.')}
              />
            </label>
            <label>
              Supabase publishable key
              <input
                value={settings.supabasePublishableKey}
                placeholder="sb_publishable_..."
                onChange={(event) => void saveMessage({ supabasePublishableKey: event.target.value }, 'Supabase key saved.')}
              />
            </label>
            <label>
              Event ID
              <input
                value={settings.eventId}
                placeholder="Supabase event UUID"
                onChange={(event) => void saveMessage({ eventId: event.target.value }, 'Event ID saved.')}
              />
            </label>
            <label>
              Booth secret
              <input
                type="password"
                value={settings.boothSecret}
                placeholder="Matches BOOTH_SHARED_SECRET"
                onChange={(event) => void saveMessage({ boothSecret: event.target.value }, 'Booth secret saved.')}
              />
            </label>
            <div className="admin-actions">
              <button
                onClick={async () => {
                  await window.photoBooth.openGuestPickerPreview();
                  setMessage('Guest photo picker opened.');
                }}
              >
                Open photo picker
              </button>
            </div>
            <div className="admin-actions">
              <button
                onClick={async () => {
                  const result = await window.photoBooth.exportSettings();
                  setMessage(result.ok && result.filePath ? `Settings exported to ${result.filePath}` : result.error ?? 'Settings export cancelled.');
                }}
              >
                <Download size={16} />Export settings
              </button>
              <button
                onClick={async () => {
                  const result = await window.photoBooth.importSettings();
                  if (result.ok && result.settings) {
                    await reloadSettings();
                    setMessage(result.filePath ? `Settings imported from ${result.filePath}` : 'Settings imported.');
                    await refreshGallery();
                    return;
                  }
                  setMessage(result.error ?? 'Settings import cancelled.');
                }}
              >
                <FolderOpen size={16} />Import settings
              </button>
            </div>
          </AdminSection>
        )}

        {tab === 'camera' && (
          <AdminSection>
            <div className="camera-admin-layout">
              <div className="camera-settings-column">
                <label>
                  Camera
                  <select value={settings.cameraId} onChange={(event) => void saveMessage({ cameraId: event.target.value }, 'Camera saved.')}>
                    <option value="">Default camera</option>
                    {cameras.map((camera) => (
                      <option key={camera.deviceId} value={camera.deviceId}>{camera.label || 'Camera'}</option>
                    ))}
                  </select>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.mirrorPreview}
                    onChange={(event) => void saveMessage({ mirrorPreview: event.target.checked }, 'Mirror setting saved.')}
                  />
                  Mirror preview
                </label>
                <label>
                  Camera rotation
                  <select
                    value={settings.cameraRotation}
                    onChange={(event) =>
                      void saveMessage({ cameraRotation: Number(event.target.value) as CameraRotation }, 'Camera rotation saved.')
                    }
                  >
                    <option value={0}>0 degrees</option>
                    <option value={90}>90 degrees</option>
                    <option value={180}>180 degrees</option>
                    <option value={270}>270 degrees</option>
                  </select>
                </label>
                <label>
                  Preview overlay
                  <div className="segmented-control">
                    <button
                      className={settings.cameraPreviewOverlay === 'none' ? 'active' : ''}
                      onClick={() => void saveMessage({ cameraPreviewOverlay: 'none' }, 'Preview overlay saved.')}
                    >
                      None
                    </button>
                  </div>
                </label>
                <div className="camera-controls-panel">
                  <div className="panel-title-row">
                    <h2>Camera controls</h2>
                    <button onClick={resetCameraControls}>Default</button>
                  </div>
                  <CameraControlPanel capabilities={cameraCapabilities} values={settings.cameraControls} onChange={saveCameraControl} />
                </div>
              </div>
              <div className="camera-preview-column">
                <div className={`admin-preview ${getCameraOrientationClass(settings)}`}>
                  <video
                    ref={cameraPreviewRef}
                    className={getCameraVideoClass(settings)}
                    style={getCameraVideoStyle(settings.cameraControls, cameraCapabilities)}
                    muted
                    playsInline
                  />
                  {!adminStream && <span>No preview</span>}
                </div>
                <button className="admin-action" onClick={refreshCameras}><RefreshCw size={16} />Refresh cameras</button>
              </div>
            </div>
          </AdminSection>
        )}

        {tab === 'printer' && (
          <AdminSection>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.printerEnabled}
                onChange={(event) => void saveMessage({ printerEnabled: event.target.checked }, event.target.checked ? 'Printer enabled.' : 'Printer disabled.')}
              />
              Printer on
            </label>
            <label>
              Default printer
              <select value={settings.defaultPrinter} onChange={(event) => void saveMessage({ defaultPrinter: event.target.value }, 'Printer saved.')}>
                <option value="">System default</option>
                {printers.map((printer) => (
                  <option key={printer.name} value={printer.name}>{printer.displayName || printer.name}</option>
                ))}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.silentPrint}
                onChange={(event) => void saveMessage({ silentPrint: event.target.checked }, 'Silent print saved.')}
              />
              Silent print
            </label>
            <div className="workflow-shot">
              <h2>Template printers</h2>
              <div className="workflow-grid">
                {settings.template.layouts.map((layout) => (
                  <label key={layout.id}>
                    {layout.name} printer
                    <select
                      value={layout.printerName}
                      onChange={(event) =>
                        void saveMessage({
                          template: {
                            ...settings.template,
                            layouts: settings.template.layouts.map((item) =>
                              item.id === layout.id ? { ...item, printerName: event.target.value } : item
                            )
                          }
                        }, 'Template printer saved.')
                      }
                    >
                      <option value="">Default printer</option>
                      {layout.printerName &&
                        !printers.some((printer) => printer.name === layout.printerName) && (
                          <option value={layout.printerName}>{layout.printerName}</option>
                        )}
                      {printers.map((printer) => (
                        <option key={`${layout.id}-${printer.name}`} value={printer.name}>{printer.displayName || printer.name}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <div className="workflow-shot">
              <h2>Printer crop guide</h2>
              <div className="workflow-grid">
                <label>
                  Left crop
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.leftBleedIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            leftBleedIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Right crop
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.rightBleedIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            rightBleedIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Top crop
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.topBleedIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            topBleedIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Bottom crop
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.bottomBleedIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            bottomBleedIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
              </div>
            </div>
            <div className="admin-actions">
              <button onClick={refreshPrinters}><RefreshCw size={16} />Refresh printers</button>
              <button onClick={() => latestFinal && window.photoBooth.printImage(latestFinal.path, latestFinal.printerName || settings.defaultPrinter)}><Printer size={16} />Reprint last photo</button>
              <button onClick={() => window.photoBooth.openPrinterSettings()}>Printer settings</button>
            </div>
          </AdminSection>
        )}

        {tab === 'workflow' && (
          <AdminSection>
            <label>
              Intro message
              <input
                value={settings.workflow.introMessage}
                onChange={(event) =>
                  void saveMessage({ workflow: { ...settings.workflow, introMessage: event.target.value } }, 'Workflow saved.')
                }
              />
            </label>
            <label>
              Intro seconds
              <input
                type="number"
                min="0"
                step="0.5"
                value={msToSeconds(settings.workflow.introMs)}
                onChange={(event) =>
                  void saveMessage(
                    { workflow: { ...settings.workflow, introMs: secondsToMs(event.target.value) } },
                    'Workflow saved.'
                  )
                }
              />
            </label>
            <label>
              Auto print seconds
              <input
                type="number"
                min="0"
                step="1"
                value={msToSeconds(settings.workflow.printAutoSelectMs)}
                onChange={(event) =>
                  void saveMessage(
                    { workflow: { ...settings.workflow, printAutoSelectMs: secondsToMs(event.target.value) } },
                    'Workflow saved.'
                  )
                }
              />
            </label>
            <label>
              Thank you message
              <input
                value={settings.workflow.thankYouMessage}
                onChange={(event) =>
                  void saveMessage({ workflow: { ...settings.workflow, thankYouMessage: event.target.value } }, 'Workflow saved.')
                }
              />
            </label>
            <label>
              Thank you seconds
              <input
                type="number"
                min="1"
                step="0.5"
                value={msToSeconds(settings.workflow.thankYouMs)}
                onChange={(event) =>
                  void saveMessage({ workflow: { ...settings.workflow, thankYouMs: secondsToMs(event.target.value) } }, 'Workflow saved.')
                }
              />
            </label>

            <div className="workflow-shot audio-settings-panel">
              <div className="panel-title-row">
                <h2>Voice, music, and sound effects</h2>
                <label className="check-row compact-check">
                  <input
                    type="checkbox"
                    checked={settings.audio.enabled}
                    onChange={(event) =>
                      void saveAudioSettings({ ...settings.audio, enabled: event.target.checked })
                    }
                  />
                  Audio enabled
                </label>
              </div>
              <div className="workflow-grid audio-global-grid">
                {[
                  ['masterVolume', 'Master volume'],
                  ['voiceVolume', 'Voice volume'],
                  ['musicVolume', 'Music volume'],
                  ['sfxVolume', 'SFX volume'],
                  ['speed', 'Host speed'],
                  ['volume', 'Host volume'],
                  ['welcomeRepeatSeconds', 'Welcome repeat seconds']
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min={key === 'speed' ? 0.5 : key === 'welcomeRepeatSeconds' ? 3 : 0}
                      max={key === 'speed' ? 2 : key === 'welcomeRepeatSeconds' ? 60 : 1}
                      step={key === 'welcomeRepeatSeconds' ? 1 : 0.05}
                      value={settings.audio[key as keyof AppSettings['audio']] as number}
                      onChange={(event) =>
                        void saveAudioSettings({
                          ...settings.audio,
                          [key]: Number(event.target.value)
                        })
                      }
                    />
                  </label>
                ))}
                <label>
                  Voice engine
                  <select
                    value={settings.audio.voiceEngine}
                    onChange={(event) =>
                      void saveAudioSettings({ ...settings.audio, voiceEngine: event.target.value as AppSettings['audio']['voiceEngine'] })
                    }
                  >
                    <option value="kokoro">Kokoro</option>
                    <option value="piper">Piper</option>
                  </select>
                </label>
                <label>
                  Voice name
                  <input
                    value={settings.audio.voiceName}
                    placeholder={settings.audio.voiceEngine === 'kokoro' ? 'af_heart' : 'en_US-lessac-medium'}
                    onChange={(event) =>
                      void saveAudioSettings({ ...settings.audio, voiceName: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="admin-actions">
                <label className="check-row compact-check">
                  <input
                    type="checkbox"
                    checked={settings.audio.enableHostVoice}
                    onChange={(event) =>
                      void saveAudioSettings({ ...settings.audio, enableHostVoice: event.target.checked })
                    }
                  />
                  Enable host voice
                </label>
                <button onClick={() => void generateAllHostVoiceCues()}>Generate all host lines</button>
              </div>
              <p className="muted">
                Host voice is generated offline into cached WAV files. Bundle Kokoro or Piper under resources/tts, or place tools in the event folder under audio/tts.
              </p>
            </div>

            <div className="audio-cue-group">
              <h2>Screen voice</h2>
              <div className="audio-cue-grid">
                {['welcome', 'style', 'design'].map((cueId) => (
                  <AudioCueCard
                    key={cueId}
                    cue={settings.audio.cues[cueId]}
                    settings={settings}
                    onSave={saveAudioCue}
                    onUpload={uploadAudioCue}
                    onRemove={removeAudioCue}
                    onGenerate={generateHostVoiceCue}
                    onTest={(cue) => cue.mode === 'host' && !cue.filePath ? generateHostVoiceCue(cue.id, true) : playAudioCue(settings, cue.id)}
                  />
                ))}
              </div>
            </div>

            <div className="audio-cue-group">
              <h2>Countdown, music, and SFX</h2>
              <div className="audio-cue-grid">
                {['countdown3', 'countdown2', 'countdown1', 'button', 'shutter', 'backgroundMusic'].map((cueId) => (
                  <AudioCueCard
                    key={cueId}
                    cue={settings.audio.cues[cueId]}
                    settings={settings}
                    onSave={saveAudioCue}
                    onUpload={uploadAudioCue}
                    onRemove={removeAudioCue}
                    onGenerate={generateHostVoiceCue}
                    onTest={(cue) => cue.mode === 'host' && !cue.filePath ? generateHostVoiceCue(cue.id, true) : playAudioCue(settings, cue.id)}
                  />
                ))}
              </div>
            </div>

          </AdminSection>
        )}

        {tab === 'template' && (
          <AdminSection>
            {(() => {
              const layouts = settings.template.layouts.map(normalizeTemplateLayoutForClient);
              const selectedLayout = layouts.find((layout) => layout.id === selectedAdminTemplateId) ?? layouts[0] ?? null;
              const selectedDesigns = selectedLayout
                ? settings.template.designs.filter((design) => design.templateId === selectedLayout.id)
                : [];
              return (
                <div className="template-manager custom-template-manager">
                  <div className="admin-actions">
                    <button onClick={() => setEditingTemplate(createBlankTemplateLayout())}>Create Template</button>
                    <button onClick={() => void importTemplate()}>Import Template</button>
                  </div>
                  <div className="custom-template-layout">
                    <div className="template-list-panel">
                      {layouts.map((layout) => (
                        <button
                          key={layout.id}
                          className={selectedLayout?.id === layout.id ? 'active template-list-item' : 'template-list-item'}
                          onClick={() => setSelectedAdminTemplateId(layout.id)}
                        >
                          <TemplateMini layout={layout} />
                          <span>{layout.name}</span>
                          <small>{layout.orientation} / {layout.photoWindows.length} photo{layout.photoWindows.length === 1 ? '' : 's'}</small>
                        </button>
                      ))}
                      {layouts.length === 0 && <p className="muted">Create or import a template to begin.</p>}
                    </div>
                    {selectedLayout && (
                      <div className="template-detail-panel">
                        <div className="template-style-summary">
                          <TemplateMini layout={selectedLayout} />
                          <div>
                            <h2>{selectedLayout.name}</h2>
                            <p>{selectedLayout.photoWindows.length} photos / {selectedLayout.orientation}</p>
                            <p>{selectedLayout.paperWidth} x {selectedLayout.paperHeight} frame PNG.</p>
                            {(() => {
                              const slotCount = selectedLayout.photoWindows.length;
                              const photosToTake = normalizePhotosToTake(selectedLayout.photosToTake, slotCount);
                              return (
                                <label className="template-photos-to-take">
                                  <span>Photos to take</span>
                                  <input
                                    type="number"
                                    min={slotCount}
                                    max={MAX_PHOTOS_TO_TAKE}
                                    value={photosToTake}
                                    onChange={(event) => {
                                      const next = normalizePhotosToTake(Number(event.target.value), slotCount);
                                      void saveTemplateLayout({ ...selectedLayout, photosToTake: next });
                                    }}
                                  />
                                  <small>
                                    {photosToTake > slotCount
                                      ? `Guest takes ${photosToTake}, then picks ${slotCount} to print.`
                                      : `Guest takes ${slotCount} (one per photo slot).`}
                                  </small>
                                </label>
                              );
                            })()}
                            <div className="admin-actions">
                              <button onClick={() => setEditingTemplate(selectedLayout)}>Edit layout</button>
                              <button onClick={() => void saveGuide(selectedLayout)}>Download blank guide</button>
                              <button onClick={() => void uploadTemplate(selectedLayout.id)}>Add print frame PNG</button>
                              <button onClick={() => void exportTemplate(selectedLayout.id)}>Export JSON</button>
                              <button className="danger" onClick={() => void deleteTemplateLayout(selectedLayout.id)}>Delete template</button>
                            </div>
                          </div>
                        </div>
                        <TemplateWorkflowEditor
                          workflow={selectedLayout.workflowDefaults}
                          shotCount={normalizePhotosToTake(selectedLayout.photosToTake, selectedLayout.photoWindows.length)}
                          cueScopeId={`template-${selectedLayout.id}`}
                          settings={settings}
                          onChange={(workflowDefaults) => void saveTemplateLayout({ ...selectedLayout, workflowDefaults })}
                          onUploadCue={uploadTemplateAudioCue}
                          onRemoveCue={removeTemplateAudioCue}
                          onGenerateCue={generateTemplateHostVoiceCue}
                        />
                        <div className="template-design-grid">
                          {selectedDesigns.map((design) => (
                            <TemplateDesignAdminCard
                              key={design.id}
                              design={design}
                              settings={settings}
                              layout={selectedLayout}
                              onSave={saveTemplateDesign}
                              onUpdateAsset={updateTemplateAsset}
                              onDelete={deleteTemplateDesign}
                              onUploadTemplateAudioCue={uploadTemplateAudioCue}
                              onRemoveTemplateAudioCue={removeTemplateAudioCue}
                              onGenerateTemplateCue={generateTemplateHostVoiceCue}
                            />
                          ))}
                        </div>
                        {selectedDesigns.length === 0 && <p className="muted">No designs uploaded for this template yet.</p>}
                      </div>
                    )}
                  </div>
                  {editingTemplate && (
                    <TemplateCreator
                      initialLayout={editingTemplate}
                      onCancel={() => setEditingTemplate(null)}
                      onSave={(layout) => void saveTemplateLayout(layout)}
                    />
                  )}
                </div>
              );
            })()}
          </AdminSection>
        )}

        {tab === 'colorFilters' && (
          <AdminSection>
            <ColorFilterStudio
              settings={settings}
              selectedPreset={selectedColorFilter}
              selectedPresetId={selectedColorFilterId}
              onSelect={setSelectedColorFilterId}
              onSavePreset={saveColorFilterPreset}
              onAddPreset={addColorFilterPreset}
              onDuplicatePreset={duplicateColorFilterPreset}
              onDeletePreset={deleteColorFilterPreset}
              onUploadThumbnail={uploadColorFilterThumbnail}
              onUploadExample={uploadColorFilterExample}
              onGenerateAllThumbnails={generateAllColorFilterThumbnails}
              onGenerateThumbnail={generateColorFilterThumbnail}
              onSaveSettings={saveMessage}
            />
          </AdminSection>
        )}

        {tab === 'faceAssets' && (
          <AdminSection>
            <div className="face-assets-layout">
              <div className="face-pack-list">
                <div className="admin-actions">
                  <button onClick={() => void addFaceAssetPack()}>Add pack</button>
                </div>
                {settings.template.faceAssetPacks.map((pack) => (
                  <button
                    key={pack.id}
                    className={pack.id === selectedFaceAssetPackId ? 'active' : ''}
                    onClick={() => setSelectedFaceAssetPackId(pack.id)}
                  >
                    <span>{pack.name}</span>
                    <small>{pack.assets.length} asset{pack.assets.length === 1 ? '' : 's'}</small>
                  </button>
                ))}
                {settings.template.faceAssetPacks.length === 0 && <p className="muted">No face asset packs yet.</p>}
              </div>

              <div className="face-pack-editor">
                {!selectedFaceAssetPack && <p className="muted">Create a pack, then upload transparent PNG assets.</p>}
                {selectedFaceAssetPack && (
                  <>
                    <div className="workflow-shot">
                      <h2>Pack Settings</h2>
                      <div className="workflow-grid">
                        <label>
                          Pack name
                          <input
                            value={selectedFaceAssetPack.name}
                            onChange={(event) => void saveFaceAssetPack({ ...selectedFaceAssetPack, name: event.target.value })}
                          />
                        </label>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={selectedFaceAssetPack.active}
                            onChange={(event) => void saveFaceAssetPack({ ...selectedFaceAssetPack, active: event.target.checked })}
                          />
                          Active
                        </label>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={selectedFaceAssetPack.assignPerFace}
                            onChange={(event) => void saveFaceAssetPack({ ...selectedFaceAssetPack, assignPerFace: event.target.checked })}
                          />
                          Assign per person
                        </label>
                      </div>
                      <div className="face-pack-guest-preview">
                        <h3>Guest preview</h3>
                        <div className="face-pack-guest-preview-row">
                          {selectedFaceAssetPack.guestPreviewPath ? (
                            <ImagePathThumb path={selectedFaceAssetPack.guestPreviewPath} label={selectedFaceAssetPack.name} />
                          ) : (
                            <p className="muted">Upload a preview image for the guest selection screen.</p>
                          )}
                          <button onClick={() => void uploadFaceAssetPackPreview(selectedFaceAssetPack.id)}>Upload guest preview</button>
                        </div>
                      </div>
                      <div className="admin-actions">
                        <button onClick={() => void uploadFaceAsset(selectedFaceAssetPack.id)}>Upload PNG asset</button>
                        <button onClick={() => void window.photoBooth.openFaceAssetPreview(selectedFaceAssetPack.id)}>Open preview window</button>
                        <button className="danger" onClick={() => void deleteFaceAssetPack(selectedFaceAssetPack.id)}>Delete pack</button>
                      </div>
                      <p className="muted">Use transparent PNGs. Good starting points: glasses centered on eyes, hats above forehead, noses on nose tip, mouths over lips, face around full face.</p>
                      <p className="muted">Assign per person: when several faces are detected, each person gets a different asset of each kind (e.g. hats, glasses), cycling through every asset of that kind before any repeats.</p>
                    </div>

                    <div className="face-asset-list">
                      {selectedFaceAssetPack.assets
                        .slice()
                        .sort((a, b) => a.order - b.order)
                        .map((asset) => (
                          <article className="face-asset-card" key={asset.id}>
                            <FaceAssetThumb asset={asset} />
                            <div className="face-asset-fields">
                              <div className="face-asset-header">
                                <input
                                  value={asset.name}
                                  onChange={(event) =>
                                    void saveFaceAssetPack({
                                      ...selectedFaceAssetPack,
                                      assets: selectedFaceAssetPack.assets.map((item) =>
                                        item.id === asset.id ? { ...item, name: event.target.value, updatedAt: new Date().toISOString() } : item
                                      )
                                    })
                                  }
                                />
                                <label>
                                  <span>Placement</span>
                                  <select
                                    value={asset.placement}
                                    onChange={(event) =>
                                      void saveFaceAssetPack({
                                        ...selectedFaceAssetPack,
                                        assets: selectedFaceAssetPack.assets.map((item) =>
                                          item.id === asset.id
                                            ? { ...item, placement: event.target.value as FaceAssetPlacement, updatedAt: new Date().toISOString() }
                                            : item
                                        )
                                      })
                                    }
                                  >
                                    {FACE_ASSET_PLACEMENTS.map((placement) => (
                                      <option key={placement} value={placement}>{placement}</option>
                                    ))}
                                  </select>
                                </label>
                                <label className="check-row face-asset-active">
                                  <input
                                    type="checkbox"
                                    checked={asset.active}
                                    onChange={(event) => void saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { active: event.target.checked }))}
                                  />
                                  Active
                                </label>
                              </div>
                              <div className="face-asset-controls-grid">
                                <FaceAssetNumberField label="Scale" value={asset.scale} step="0.05" onChange={(value) => saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { scale: value }))} />
                                <FaceAssetNumberField label="X offset" value={asset.xOffset} step="0.02" onChange={(value) => saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { xOffset: value }))} />
                                <FaceAssetNumberField label="Y offset" value={asset.yOffset} step="0.02" onChange={(value) => saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { yOffset: value }))} />
                                <FaceAssetNumberField label="Rotation" value={asset.rotation} step="1" onChange={(value) => saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { rotation: value }))} />
                                <FaceAssetNumberField label="Opacity" value={asset.opacity} step="0.05" min="0" max="1" onChange={(value) => saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { opacity: value }))} />
                                <FaceAssetNumberField label="Order" value={asset.order} step="1" onChange={(value) => saveFaceAssetPack(updatePackAsset(selectedFaceAssetPack, asset.id, { order: value }))} />
                              </div>
                              <div className="admin-actions face-asset-actions">
                                <button onClick={() => window.photoBooth.openFile(asset.path)}>Open</button>
                                <button className="danger" onClick={() => void removeFaceAsset(selectedFaceAssetPack.id, asset.id)}>Remove</button>
                              </div>
                            </div>
                          </article>
                        ))}
                      {selectedFaceAssetPack.assets.length === 0 && <p className="muted">Upload a transparent PNG to start calibrating.</p>}
                    </div>
                  </>
                )}
              </div>
            </div>
          </AdminSection>
        )}

        {tab === 'aiPresets' && (
          <AdminSection>
            <div className="workflow-shot">
              <h2>AI Provider</h2>
              <div className="workflow-grid">
                <label>
                  Active provider
                  <select
                    value={settings.ai.provider}
                    onChange={(event) => void saveMessage({ ai: { ...settings.ai, provider: event.target.value as AiProvider } }, 'AI settings saved.')}
                  >
                    <option value="openai">ChatGPT / OpenAI</option>
                    <option value="gemini">Gemini</option>
                    <option value="xai">Grok / xAI</option>
                  </select>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.ai.providers[settings.ai.provider].enabled}
                    onChange={(event) => void updateAiProvider(settings.ai.provider, { enabled: event.target.checked })}
                  />
                  Enabled
                </label>
                <label>
                  Model
                  <input
                    value={settings.ai.providers[settings.ai.provider].model}
                    onChange={(event) => void updateAiProvider(settings.ai.provider, { model: event.target.value })}
                  />
                </label>
                <label>
                  Thinking level
                  <select
                    value={settings.ai.thinkingLevel}
                    onChange={(event) =>
                      void saveMessage({
                        ai: { ...settings.ai, thinkingLevel: event.target.value as AppSettings['ai']['thinkingLevel'] }
                      }, 'AI settings saved.')
                    }
                  >
                    <option value="none">None</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                {settings.ai.provider === 'openai' && (
                  <>
                    <label>
                      Output size
                      <select
                        value={settings.ai.providers.openai.size || '1024x1536'}
                        onChange={(event) => void updateAiProvider('openai', { size: event.target.value })}
                      >
                        <option value="1024x1536">Portrait 1024 x 1536</option>
                        <option value="1536x1024">Landscape 1536 x 1024</option>
                        <option value="1024x1024">Square 1024 x 1024</option>
                        <option value="2160x3840">4K Portrait 2160 x 3840</option>
                        <option value="3840x2160">4K Landscape 3840 x 2160</option>
                        <option value="auto">Auto</option>
                      </select>
                    </label>
                    <label>
                      Quality
                      <select
                        value={settings.ai.providers.openai.quality || 'low'}
                        onChange={(event) => void updateAiProvider('openai', { quality: event.target.value })}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="auto">Auto</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
              <label>
                API key
                <input
                  type="password"
                  value={settings.ai.providers[settings.ai.provider].apiKey}
                  onChange={(event) => void updateAiProvider(settings.ai.provider, { apiKey: event.target.value })}
                />
              </label>
              <label>
                API URL
                <input
                  value={settings.ai.providers[settings.ai.provider].apiUrl}
                  onChange={(event) => void updateAiProvider(settings.ai.provider, { apiUrl: event.target.value })}
                />
              </label>
              <label>
                Global system prompt
                <DraftTextarea
                  value={settings.ai.systemPrompt}
                  onSave={(value) => saveMessage({ ai: { ...settings.ai, systemPrompt: value } }, 'AI settings saved.')}
                />
              </label>
            </div>

            <div className="workflow-shot">
              <h2>Create preset</h2>
              <div className="workflow-grid">
                <label>
                  Preset name
                  <input value={aiPresetDraft.name} onChange={(event) => setAiPresetDraft({ ...aiPresetDraft, name: event.target.value })} />
                </label>
                <label>
                  Prompt
                  <input value={aiPresetDraft.prompt} onChange={(event) => setAiPresetDraft({ ...aiPresetDraft, prompt: event.target.value })} />
                </label>
              </div>
              <div className="admin-actions">
                <button onClick={() => void addAiPreset()}><Sparkles size={16} />Add AI preset</button>
              </div>
            </div>

            <div className="ai-preset-list">
              {settings.template.aiPresets.map((preset) => (
                <article className="ai-preset-card" key={preset.id}>
                  <div className="ai-preset-fields">
                    <input value={preset.name} onChange={(event) => void saveAiPreset({ ...preset, name: event.target.value })} />
                    <DraftTextarea value={preset.prompt} onSave={(value) => saveAiPreset({ ...preset, prompt: value })} />
                  </div>
                  <label className="check-row">
                    <input type="checkbox" checked={preset.active} onChange={(event) => void saveAiPreset({ ...preset, active: event.target.checked })} />
                    Active
                  </label>
                  <AiPresetImageStrip preset={preset} onRemove={removeAiPresetImage} />
                  <div className="admin-actions">
                    <button onClick={() => void uploadAiPresetImage(preset.id)}>Add image</button>
                    <button className="danger" onClick={() => void deleteAiPreset(preset.id)}>Delete</button>
                  </div>
                </article>
              ))}
              {settings.template.aiPresets.length === 0 && <p className="muted">No AI presets yet.</p>}
            </div>
          </AdminSection>
        )}

        {tab === 'aiQueue' && (
          <AdminSection>
            <div className="admin-actions">
              <button onClick={() => void refreshAiQueue()}><RefreshCw size={16} />Refresh</button>
            </div>
            <div className="ai-queue-list">
              {aiQueue.map((item) => (
                <AiQueueCard
                  key={item.id}
                  item={item}
                  settings={settings}
                  onRetry={retryAiQueueItem}
                  onChanged={async () => {
                    await refreshAiQueue();
                    await refreshGallery();
                  }}
                />
              ))}
              {aiQueue.length === 0 && <p className="muted">No AI jobs yet.</p>}
            </div>
          </AdminSection>
        )}

        {tab === 'gallery' && (
          <AdminSection>
            <label>
              Search photo number
              <input value={gallerySearch} onChange={(event) => setGallerySearch(event.target.value)} placeholder="Example: 12" />
            </label>
            <div className="admin-actions">
              <button onClick={refreshGallery}><RefreshCw size={16} />Refresh gallery</button>
            </div>
            <GalleryList title="Finals" photos={filteredFinals} settings={settings} onChanged={refreshGallery} />
          </AdminSection>
        )}
      </section>
    </main>
  );
}

function AudioCueCard({
  cue,
  settings,
  onSave,
  onUpload,
  onRemove,
  onGenerate,
  onTest
}: {
  cue?: AudioCue;
  settings: AppSettings;
  onSave: (cue: AudioCue) => Promise<void>;
  onUpload: (cueId: string) => Promise<void>;
  onRemove: (cueId: string) => Promise<void>;
  onGenerate: (cueId: string, playAfterGenerate?: boolean) => Promise<void>;
  onTest: (cue: AudioCue) => void;
}) {
  if (!cue) return null;
  const fileName = cue.filePath.split(/[\\/]/).pop() || '';
  return (
    <div className="audio-cue-card">
      <div className="audio-cue-head">
        <label className="check-row compact-check">
          <input
            type="checkbox"
            checked={cue.enabled}
            onChange={(event) => void onSave({ ...cue, enabled: event.target.checked })}
          />
          {cue.label}
        </label>
        <button type="button" onClick={() => onTest(cue)}>Test</button>
      </div>
      <div className="audio-cue-controls">
        <label>
          Mode
          <select value={cue.mode} onChange={(event) => void onSave({ ...cue, mode: event.target.value as AudioCue['mode'] })}>
            <option value="off">Off</option>
            <option value="mp3">MP3</option>
            {cue.channel === 'voice' && <option value="host">Host voice</option>}
          </select>
        </label>
        <label>
          Volume
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={cue.volume}
            onChange={(event) => void onSave({ ...cue, volume: Number(event.target.value) })}
          />
        </label>
        <label className="check-row compact-check">
          <input
            type="checkbox"
            checked={cue.loop}
            onChange={(event) => void onSave({ ...cue, loop: event.target.checked })}
          />
          Loop
        </label>
      </div>
      {cue.channel === 'voice' && (
        <label>
          Spoken text
          <input value={cue.text} onChange={(event) => void onSave({ ...cue, text: event.target.value })} />
        </label>
      )}
      <div className="audio-file-row">
        <button type="button" onClick={() => void onUpload(cue.id)}>Upload MP3</button>
        {cue.channel === 'voice' && <button type="button" onClick={() => void onGenerate(cue.id)}>Generate</button>}
        <button type="button" onClick={() => void onRemove(cue.id)} disabled={!cue.filePath}>Clear</button>
        <span title={cue.filePath}>{fileName || (cue.mode === 'mp3' ? 'No file' : settings.audio.enabled ? 'No file' : 'Audio off')}</span>
      </div>
    </div>
  );
}

function AdminSection({ children }: { children: React.ReactNode }) {
  return <div className="admin-section">{children}</div>;
}

function FaceAssetPreviewApp() {
  const query = new URLSearchParams(window.location.search);
  const packId = query.get('packId') ?? '';
  const { settings, refreshSettings } = useSettings();
  const [error, setError] = useState('');
  const [showDebug, setShowDebug] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stabilizerRef = useRef(new FaceAssetStabilizer());

  const pack = settings?.template.faceAssetPacks.find((candidate) => candidate.id === packId) ?? null;

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshSettings();
    }, 350);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!settings) return undefined;
    let stream: MediaStream | null = null;
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: settings.cameraId ? { deviceId: { exact: settings.cameraId } } : true,
          audio: false
        });
        await applyCameraControls(stream, settings.cameraControls);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        setError('Camera preview failed.');
      }
    };
    void start();
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [settings?.cameraId]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!settings || !canvas || !pack?.active) {
      if (canvas) clearFaceAssetCanvas(canvas, canvas.width, canvas.height);
      stabilizerRef.current.reset();
      return undefined;
    }

    let animationFrame = 0;
    let canceled = false;
    let busy = false;
    let lastDetectionAt = 0;
    let missedFrames = 0;
    const tracker = new FaceTracker();

    const drawOverlay = (now: number) => {
      if (!canceled) animationFrame = window.requestAnimationFrame(drawOverlay);
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (!canceled && video && overlay && video.videoWidth > 0 && video.videoHeight > 0 && !busy && now - lastDetectionAt > 66) {
        busy = true;
        lastDetectionAt = now;
        void (async () => {
          try {
          const displayWidth = Math.max(1, Math.round(overlay.clientWidth));
          const displayHeight = Math.max(1, Math.round(overlay.clientHeight));
          const displayResult = await detectDisplayedFaces(video, displayWidth, displayHeight, settings, now);
          clearFaceAssetCanvas(overlay, displayWidth, displayHeight);
          const ctx = overlay.getContext('2d');
          if (displayResult.faceLandmarks.length === 0) {
            missedFrames += 1;
            if (ctx) {
              await drawFaceAssets(ctx, displayResult, pack, overlay.width, overlay.height, stabilizerRef.current, tracker);
            }
            if (missedFrames > 60) {
              stabilizerRef.current.reset();
              tracker.reset();
            }
            return;
          }
          missedFrames = 0;
          if (ctx) {
            await drawFaceAssets(ctx, displayResult, pack, overlay.width, overlay.height, stabilizerRef.current, tracker);
            if (showDebug) drawFaceDebugInfo(ctx, displayResult, overlay.width, overlay.height);
          }
        } catch (error) {
          console.warn('Face assets preview skipped.', error);
        } finally {
          busy = false;
        }
        })();
      }
    };

    animationFrame = window.requestAnimationFrame(drawOverlay);
    return () => {
      canceled = true;
      window.cancelAnimationFrame(animationFrame);
      clearFaceAssetCanvas(canvas, canvas.width, canvas.height);
      stabilizerRef.current.reset();
    };
  }, [pack, settings, showDebug]);

  if (!settings) return <main className="face-preview-window"><p className="quiet">LOADING</p></main>;

  return (
    <main className="face-preview-window">
      <div className="face-preview-header">
        <strong>{pack?.name ?? 'FACE ASSET PREVIEW'}</strong>
        <div className="face-preview-header-actions">
          <span>{pack ? `${pack.assets.length} ASSET${pack.assets.length === 1 ? '' : 'S'}` : 'NO PACK SELECTED'}</span>
          <button onClick={() => setShowDebug((current) => !current)}>
            {showDebug ? 'Hide debug' : 'Show debug'}
          </button>
        </div>
      </div>
      <div className={`face-preview-stage ${getCameraOrientationClass(settings)}`}>
        <video ref={videoRef} className={getCameraVideoClass(settings)} muted playsInline />
        <canvas ref={overlayRef} className="face-preview-overlay" aria-hidden="true" />
        {error && <p className="guest-error">{error}</p>}
      </div>
    </main>
  );
}

function DraftTextarea({
  value,
  placeholder,
  onSave
}: {
  value: string;
  placeholder?: string;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setDraft(value);
  }, [isFocused, value]);

  return (
    <textarea
      value={draft}
      placeholder={placeholder}
      onFocus={() => setIsFocused(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setIsFocused(false);
        if (draft !== value) void onSave(draft);
      }}
    />
  );
}

function AiPresetImageStrip({
  preset,
  onRemove
}: {
  preset: AiPreset;
  onRemove: (presetId: string, imageId: string) => Promise<void>;
}) {
  return (
    <div className="ai-reference-strip">
      {(preset.referenceImages ?? []).map((image, index) => (
        <AiReferenceThumb
          key={image.id}
          path={image.path}
          label={`${index + 1}`}
          onRemove={() => onRemove(preset.id, image.id)}
        />
      ))}
      {(preset.referenceImages ?? []).length === 0 && <span className="muted">No reference images</span>}
    </div>
  );
}

function AiReferenceThumb({ path, label, onRemove }: { path: string; label: string; onRemove: () => Promise<void> }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    void window.photoBooth
      .getImageDataUrl(path)
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {
        if (active) setSrc('');
      });
    return () => {
      active = false;
    };
  }, [path]);

  return (
    <div className="ai-reference-thumb">
      {src ? <img src={src} alt={`AI reference ${label}`} /> : <Image size={20} />}
      <span>{label}</span>
      <button title="Remove" aria-label="Remove reference image" onClick={() => void onRemove()}>
        <X size={13} />
      </button>
    </div>
  );
}

function FaceAssetThumb({ asset }: { asset: FaceAsset }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    void window.photoBooth
      .getImageDataUrl(asset.path)
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {
        if (active) setSrc('');
      });
    return () => {
      active = false;
    };
  }, [asset.path]);

  return (
    <div className="face-asset-thumb">
      {src ? <img src={src} alt={asset.name} /> : <Image size={18} />}
      <span>{asset.placement}</span>
    </div>
  );
}

function FaceAssetNumberField({
  label,
  value,
  step,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  step: string;
  min?: string;
  max?: string;
  onChange: (value: number) => Promise<unknown>;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => void onChange(Number(event.target.value))}
      />
    </label>
  );
}

function AiQueueCard({
  item,
  settings,
  onRetry,
  onChanged
}: {
  item: AiQueueItem;
  settings: AppSettings;
  onRetry: (itemId: string) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [src, setSrc] = useState('');
  const previewPath = item.finalPath || item.resultPath || item.inputPath;
  const design = settings.template.designs.find((candidate) => candidate.id === item.designId);
  const preset = settings.template.aiPresets.find((candidate) => candidate.id === item.presetId);

  useEffect(() => {
    let active = true;
    if (!previewPath) {
      setSrc('');
      return undefined;
    }
    void window.photoBooth
      .getImageDataUrl(previewPath)
      .then((dataUrl) => {
        if (active) setSrc(dataUrl);
      })
      .catch(() => {
        if (active) setSrc('');
      });
    return () => {
      active = false;
    };
  }, [previewPath]);

  return (
    <article className={`ai-queue-card status-${item.status}`}>
      <div className="ai-queue-thumb">{src ? <img src={src} alt={`AI job ${item.id}`} /> : <Image size={28} />}</div>
      <div className="ai-queue-main">
        <div className="ai-queue-title-row">
          <strong>
            {item.status === 'requested' && <span className="queue-spinner" aria-hidden="true" />}
            {aiQueueStatusLabel(item)}
          </strong>
          <span>{new Date(item.updatedAt).toLocaleString()}</span>
        </div>
        <p>{design?.name ?? item.designId} / {preset?.name ?? item.presetId}</p>
        <p>{item.provider.toUpperCase()} / retry {item.retryCount}</p>
        {item.requestedAt && <p>Requested at {new Date(item.requestedAt).toLocaleTimeString()}</p>}
        {item.error && <p className="ai-queue-error">{item.error}</p>}
        <div className="admin-actions">
          <button onClick={() => void onRetry(item.id)}>Retry</button>
          <button disabled={!previewPath} onClick={() => window.photoBooth.openFile(previewPath)}>Open result</button>
          <button
            disabled={!item.finalPath && !item.resultPath}
            onClick={async () => {
              await window.photoBooth.printAiQueueItem(item.id);
              await onChanged();
            }}
          >
            <Printer size={16} />Print
          </button>
        </div>
      </div>
    </article>
  );
}

function GalleryList({
  title,
  photos,
  settings,
  onChanged
}: {
  title: string;
  photos: SavedPhoto[];
  settings: AppSettings;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="gallery-list">
      <h2>{title}</h2>
      {photos.length === 0 && <p className="muted">No photos yet.</p>}
      <div className="gallery-card-grid">
        {photos.map((photo) => (
          <GalleryCard key={photo.path} photo={photo} settings={settings} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

function GalleryCard({
  photo,
  settings,
  onChanged
}: {
  photo: SavedPhoto;
  settings: AppSettings;
  onChanged: () => Promise<void>;
}) {
  const [imageSrc, setImageSrc] = useState('');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(
    photo.type === 'final' || isPortraitCamera(settings) ? 'portrait' : 'landscape'
  );

  useEffect(() => {
    let active = true;
    setOrientation(photo.type === 'final' || isPortraitCamera(settings) ? 'portrait' : 'landscape');
    void window.photoBooth
      .getImageDataUrl(photo.thumbPath ?? photo.path)
      .then((dataUrl) => {
        if (active) setImageSrc(dataUrl);
      })
      .catch(() => {
        if (active) setImageSrc('');
      });
    return () => {
      active = false;
    };
  }, [photo.path, photo.type, settings.cameraRotation]);

  return (
    <article className="gallery-card">
      <div className={`gallery-card-thumb ${orientation}`}>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={photo.name}
            onLoad={(event) => {
              const image = event.currentTarget;
              setOrientation(image.naturalHeight > image.naturalWidth ? 'portrait' : 'landscape');
            }}
          />
        ) : (
          <Image size={34} />
        )}
      </div>
      <div className="gallery-card-footer">
        <div className="gallery-card-text">
          <strong title={photo.name}>{photo.name}</strong>
          <span>{new Date(photo.createdAt).toLocaleString()}</span>
        </div>
        <div className="gallery-card-actions">
          <button title="Open" aria-label={`Open ${photo.name}`} onClick={() => window.photoBooth.openFile(photo.path)}>
            <ExternalLink size={15} />
          </button>
          <button
            title={photo.galleryUrl ? 'Open online gallery' : 'Online gallery not uploaded yet'}
            aria-label={photo.galleryUrl ? `Open online gallery for ${photo.name}` : `Online gallery not uploaded yet for ${photo.name}`}
            disabled={!photo.galleryUrl}
            onClick={() => {
              if (photo.galleryUrl) void window.photoBooth.openUrl(photo.galleryUrl);
            }}
          >
            <Globe size={15} />
          </button>
          <button
            title={photo.printerName ? `Print to ${photo.printerName}` : 'Print'}
            aria-label={`Print ${photo.name}`}
            onClick={() => window.photoBooth.printImage(photo.path, photo.printerName || settings.defaultPrinter)}
          >
            <Printer size={15} />
          </button>
          <button title="Export" aria-label={`Export ${photo.name}`} onClick={() => window.photoBooth.exportFile(photo.path)}>
            <Download size={15} />
          </button>
          <button
            className="danger"
            title="Delete"
            aria-label={`Delete ${photo.name}`}
            onClick={async () => {
              await window.photoBooth.deleteFile(photo.path);
              await onChanged();
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}

function CameraControlPanel({
  capabilities,
  values,
  onChange
}: {
  capabilities: CameraCapabilitiesMap;
  values: CameraControlSettings;
  onChange: (key: CameraControlKey, value: number) => void;
}) {
  const hardwareControls = CAMERA_CONTROL_FIELDS.filter((field) => capabilities[field.key]);
  const softwareControls = SOFTWARE_CAMERA_KEYS.filter((key) => !capabilities[key]);

  const renderSlider = (
    key: CameraControlKey,
    label: string,
    min: number,
    max: number,
    step: number,
    defaultValue: number,
    note?: string
  ) => {
    const value = values[key] ?? defaultValue;
    return (
      <label key={key}>
        {label}
        {note ? <span className="camera-control-note">{note}</span> : null}
        <div className="range-row">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(key, Number(event.target.value))}
          />
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(key, Number(event.target.value))}
          />
        </div>
      </label>
    );
  };

  if (hardwareControls.length === 0 && softwareControls.length === 0) {
    return (
      <p className="muted">
        This camera does not expose adjustable image controls. Use mirror, rotation, and lighting setup instead.
      </p>
    );
  }

  return (
    <div className="camera-control-list">
      {hardwareControls.length === 0 && softwareControls.length > 0 && (
        <p className="muted camera-control-help">
          This camera does not expose hardware brightness or color controls. Use the software adjustments below — they apply to the live preview and captured photos.
        </p>
      )}
      {hardwareControls.map((field) => {
        const capability = capabilities[field.key];
        if (!capability) return null;
        return renderSlider(field.key, field.label, capability.min, capability.max, capability.step || 1, defaultCameraControlValue(capability));
      })}
      {softwareControls.map((key) => {
        const label = CAMERA_CONTROL_FIELDS.find((field) => field.key === key)?.label ?? key;
        return renderSlider(key, label, 0, 100, 1, SOFTWARE_CAMERA_DEFAULT, hardwareControls.length > 0 ? 'Software' : undefined);
      })}
    </div>
  );
}

const drawCameraViewToCanvas = (video: HTMLVideoElement, width: number, height: number, settings: AppSettings) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const rotation = settings.cameraRotation;
  const isSideways = rotation === 90 || rotation === 270;
  const visualWidth = isSideways ? sourceHeight : sourceWidth;
  const visualHeight = isSideways ? sourceWidth : sourceHeight;
  const scale = Math.max(width / visualWidth, height / visualHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (settings.mirrorPreview) ctx.scale(-1, 1);
  ctx.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  return canvas;
};

// Upper bound on the composited capture's long edge, in pixels. Generous
// enough to fully cover the print pipeline's highest-res template space
// (2478x3690 / ~600dpi) with headroom, while keeping PNG encode time and
// memory usage reasonable on kiosk hardware.
const CAPTURE_NATIVE_MAX_LONG_EDGE = 3600;

// Renders the capture-screen camera view at up to native resolution instead of
// the guest window's physical pixel density. Returns null if the video frame
// isn't ready yet, so callers can fall back gracefully.
const captureNativeResolutionFrame = (
  video: HTMLVideoElement,
  settings: AppSettings,
  viewportWidth: number,
  viewportHeight: number
) => {
  const nativeWidth = video.videoWidth;
  const nativeHeight = video.videoHeight;
  if (!nativeWidth || !nativeHeight || viewportWidth <= 0 || viewportHeight <= 0) return null;

  const rotation = settings.cameraRotation;
  const isSideways = rotation === 90 || rotation === 270;
  const visualWidth = isSideways ? nativeHeight : nativeWidth;
  const visualHeight = isSideways ? nativeWidth : nativeHeight;

  // The CSS "cover" scale factor currently used to fit the video into the
  // screen. Its inverse renders the video at native pixel density (1 camera
  // pixel ~= 1 canvas pixel along the dominant axis) instead of being
  // downsampled to whatever resolution the screen happens to be.
  const baseCoverScale = Math.max(viewportWidth / visualWidth, viewportHeight / visualHeight);
  let outputScale = baseCoverScale > 0 && Number.isFinite(baseCoverScale) ? 1 / baseCoverScale : 1;
  outputScale = Math.max(0.1, outputScale);

  let targetWidth = Math.round(viewportWidth * outputScale);
  let targetHeight = Math.round(viewportHeight * outputScale);
  const longEdge = Math.max(targetWidth, targetHeight);
  if (longEdge > CAPTURE_NATIVE_MAX_LONG_EDGE) {
    const clamp = CAPTURE_NATIVE_MAX_LONG_EDGE / longEdge;
    targetWidth = Math.max(1, Math.round(targetWidth * clamp));
    targetHeight = Math.max(1, Math.round(targetHeight * clamp));
    outputScale *= clamp;
  }
  if (targetWidth < 1 || targetHeight < 1) return null;

  const canvas = drawCameraViewToCanvas(video, targetWidth, targetHeight, settings);
  return { canvas, outputScale };
};

const loadDataUrlImage = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image for upload.'));
    image.src = dataUrl;
  });

const downscaleDataUrl = async (dataUrl: string, maxEdge: number) => {
  const image = await loadDataUrlImage(dataUrl);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const longEdge = Math.max(naturalWidth, naturalHeight, 1);
  const scale = Math.min(1, maxEdge / longEdge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not downscale image.');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
};

const clampChannel = (value: number) => Math.max(0, Math.min(255, value));

const neutralColorFilterValues = (): ColorFilterValues => ({
  intensity: 100,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  tint: 0,
  hue: 0,
  fade: 0,
  highlights: 0,
  shadows: 0,
  vignette: 0,
  blur: 0
});

const normalizeColorFilterValuesForClient = (filter: Partial<ColorFilterValues> | undefined): ColorFilterValues => {
  const fallback = neutralColorFilterValues();
  const finite = (value: unknown, fallbackValue: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallbackValue;
  return {
    intensity: finite(filter?.intensity, fallback.intensity, 0, 100),
    brightness: finite(filter?.brightness, fallback.brightness, -50, 50),
    contrast: finite(filter?.contrast, fallback.contrast, -50, 50),
    saturation: finite(filter?.saturation, fallback.saturation, -50, 50),
    warmth: finite(filter?.warmth, fallback.warmth, -50, 50),
    tint: finite(filter?.tint, fallback.tint, -50, 50),
    hue: finite(filter?.hue, fallback.hue, -180, 180),
    fade: finite(filter?.fade, fallback.fade, 0, 50),
    highlights: finite(filter?.highlights, fallback.highlights, -50, 50),
    shadows: finite(filter?.shadows, fallback.shadows, -50, 50),
    vignette: finite(filter?.vignette, fallback.vignette, 0, 50),
    blur: finite(filter?.blur, fallback.blur, 0, 20)
  };
};

const rgbToHsl = (r: number, g: number, b: number) => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
};

const hueToRgb = (p: number, q: number, t: number) => {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

const hslToRgb = (h: number, s: number, l: number) => {
  if (s === 0) {
    const value = l * 255;
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255
  };
};

const applyPhotoFilters = async (
  dataUrl: string,
  preset: ColorFilterPreset | null,
  beautyLevel = 0
) => {
  const image = await loadDataUrlImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not apply filter.');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  if (beautyLevel > 0) {
    try {
      await applyFaceBeauty(canvas, beautyLevel);
    } catch (error) {
      console.warn('Face beauty retouch failed; using original photo.', error);
    }
  }

  const filter = normalizeColorFilterValuesForClient(preset?.filter);
  const intensity = Math.max(0, Math.min(1, filter.intensity / 100));
  const blurAmount = Math.max(0, filter.blur * intensity);
  if (blurAmount > 0) {
    const blur = document.createElement('canvas');
    blur.width = canvas.width;
    blur.height = canvas.height;
    const blurCtx = blur.getContext('2d');
    if (blurCtx) {
      blurCtx.filter = `blur(${blurAmount}px)`;
      blurCtx.drawImage(canvas, 0, 0);
      ctx.globalAlpha = Math.min(0.7, 0.18 + blurAmount / 28);
      ctx.drawImage(blur, 0, 0);
      ctx.globalAlpha = 1;
    }
  }
  if (intensity <= 0) return canvas.toDataURL('image/png');

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const brightness = filter.brightness * 2.2 * intensity;
  const contrast = 1 + (filter.contrast / 50) * 0.45 * intensity;
  const saturation = 1 + (filter.saturation / 50) * 0.9 * intensity;
  const warmth = filter.warmth * 1.45 * intensity;
  const tint = filter.tint * 1.2 * intensity;
  const hueShift = (filter.hue / 360) * intensity;
  const fade = (filter.fade / 50) * 42 * intensity;
  const highlights = filter.highlights * 1.2 * intensity;
  const shadows = filter.shadows * 1.2 * intensity;
  const vignette = (filter.vignette / 50) * 1.35 * intensity;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const maxDistance = Math.hypot(centerX, centerY);

  for (let index = 0; index < data.length; index += 4) {
    const pixel = index / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    let r = data[index];
    let g = data[index + 1];
    let b = data[index + 2];

    r = (r - 128) * contrast + 128 + brightness;
    g = (g - 128) * contrast + 128 + brightness;
    b = (b - 128) * contrast + 128 + brightness;

    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    r = luminance + (r - luminance) * saturation;
    g = luminance + (g - luminance) * saturation;
    b = luminance + (b - luminance) * saturation;

    r += warmth + tint * 0.25;
    g += -Math.abs(tint) * 0.25;
    b += -warmth + tint * 0.75;

    if (hueShift !== 0) {
      const hsl = rgbToHsl(clampChannel(r), clampChannel(g), clampChannel(b));
      const shifted = hslToRgb((hsl.h + hueShift + 1) % 1, Math.min(1, hsl.s * (1 + 0.18 * intensity)), hsl.l);
      r = shifted.r;
      g = shifted.g;
      b = shifted.b;
    }

    const highWeight = Math.max(0, (luminance - 128) / 127);
    const shadowWeight = Math.max(0, (128 - luminance) / 128);
    r += highlights * highWeight + shadows * shadowWeight;
    g += highlights * highWeight + shadows * shadowWeight;
    b += highlights * highWeight + shadows * shadowWeight;

    if (fade > 0) {
      r = r + (128 - r) * (fade / 100);
      g = g + (128 - g) * (fade / 100);
      b = b + (128 - b) * (fade / 100);
    }

    if (vignette > 0) {
      const distance = Math.hypot(x - centerX, y - centerY) / maxDistance;
      const edge = Math.max(0, (distance - 0.28) / 0.72);
      const darken = Math.max(0.08, 1 - Math.pow(edge, 1.55) * vignette);
      r *= darken;
      g *= darken;
      b *= darken;
    }

    data[index] = clampChannel(r);
    data[index + 1] = clampChannel(g);
    data[index + 2] = clampChannel(b);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
};

const createSquareFilterThumbnail = async (dataUrl: string, preset: ColorFilterPreset) => {
  const filtered = await applyPhotoFilters(dataUrl, preset, 0);
  const image = await loadDataUrlImage(filtered);
  const size = 420;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not generate filter button image.');
  const scale = Math.max(size / image.width, size / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
  return canvas.toDataURL('image/png');
};

const flipPhotoForPrint = async (dataUrl: string) => {
  const image = await loadDataUrlImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare photo for print.');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
};

const createGalleryQrCode = (galleryUrl: string) =>
  QRCode.toDataURL(galleryUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 12,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });

const addQrToPrintDataUrl = async (printDataUrl: string, qrDataUrl: string) => {
  const [printImage, qrImage] = await Promise.all([loadDataUrlImage(printDataUrl), loadDataUrlImage(qrDataUrl)]);
  const canvas = document.createElement('canvas');
  canvas.width = printImage.naturalWidth;
  canvas.height = printImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not add gallery QR code.');
  ctx.drawImage(printImage, 0, 0);

  const qrSize = Math.max(110, Math.round(Math.min(canvas.width, canvas.height) * 0.06));
  const paddingLeft = Math.round(qrSize * 0.42);
  const paddingBottom = Math.round(qrSize * 0.42);
  const x = paddingLeft;
  const y = canvas.height - qrSize - paddingBottom;

  const line1 = ' ';
  const line2 = 'Scan to Download Photo/Video @ ViboBooth.com';
  const textGap = Math.max(2, Math.round(qrSize * 0.04));
  const lineHeight = (qrSize - textGap) / 2;
  const fontSize = Math.max(5, Math.round(lineHeight * 0.78 * 0.5));
  const textPadX = Math.round(qrSize * 0.14);
  const textX = x + qrSize + textPadX;

  const bgPad = 8;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - bgPad, y - bgPad, qrSize + bgPad * 2, qrSize + bgPad * 2);
  ctx.drawImage(qrImage, x, y, qrSize, qrSize);

  ctx.font = `300 ${fontSize}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#111';
  const line2Y = y + qrSize;
  const line1Y = line2Y - textGap - fontSize;
  ctx.strokeText(line2, textX, line2Y);

  ctx.fillText(line2, textX, line2Y);
  ctx.strokeText(line1, textX, line1Y);
  ctx.fillText(line1, textX, line1Y);

  return canvas.toDataURL('image/png');
};

const detectDisplayedFaces = async (
  video: HTMLVideoElement,
  displayWidth: number,
  displayHeight: number,
  settings: AppSettings,
  timestamp: number
) => {
  // Always detect on the upright (rotation + mirror corrected) canvas. This is
  // the exact coordinate space the overlay draws in, AND it keeps MediaPipe's
  // VIDEO-mode tracker fed with a single, consistently-oriented frame. Feeding a
  // second, differently-oriented source (e.g. the raw video) corrupts the
  // tracker's internal state, which previously caused assets to stop following
  // the face after tracking was briefly lost.
  const detectionCanvas = drawCameraViewToCanvas(video, displayWidth, displayHeight, settings);
  return detectFaces(detectionCanvas, timestamp);
};

const FACE_ASSET_PLACEMENTS: FaceAssetPlacement[] = ['glasses', 'hat', 'nose', 'mouth', 'face'];

const updatePackAsset = (pack: FaceAssetPack, assetId: string, partial: Partial<FaceAsset>): FaceAssetPack => ({
  ...pack,
  assets: pack.assets.map((asset) =>
    asset.id === assetId ? { ...asset, ...partial, updatedAt: new Date().toISOString() } : asset
  )
});

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const nextPaint = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });

const coverCropToAspect = (dataUrl: string, targetAspect: number, cropY: TemplateSlot['cropY'] = 'center') =>
  new Promise<string>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const sourceAspect = image.width / image.height;
      let cropWidth = image.width;
      let cropHeight = image.height;
      let offsetX = 0;
      let offsetY = 0;
      if (sourceAspect > targetAspect) {
        cropWidth = image.height * targetAspect;
        offsetX = (image.width - cropWidth) / 2;
      } else {
        cropHeight = image.width / targetAspect;
        offsetY = cropY === 'top' ? 0 : (image.height - cropHeight) / 2;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cropWidth));
      canvas.height = Math.max(1, Math.round(cropHeight));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not ready.'));
        return;
      }
      ctx.drawImage(image, offsetX, offsetY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not load captured image.'));
    image.src = dataUrl;
  });

const waitFor = async <T,>(getValue: () => T | null, timeoutMs = 2500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = getValue();
    if (value) return value;
    await delay(50);
  }
  return null;
};

const msToSeconds = (ms: number) => Number((ms / 1000).toFixed(1));

const secondsToMs = (value: string) => Math.max(0, Math.round(Number(value || 0) * 1000));

const photoNumber = (name: string) => name.replace(/\.[^.]+$/, '');

const displayedPhotoNumber = (savedName: string, session: BoothSession | null | undefined) =>
  session?.ticket.queue_number != null ? String(session.ticket.queue_number) : photoNumber(savedName);

const templatePreviewPath = (design: TemplateDesign) => design.previewPath || design.filePath || design.framePath;

const templateFramePath = (design: TemplateDesign) => design.framePath || design.filePath || design.previewPath;

const shortPath = (filePath: string) => filePath.split(/[\\/]/).slice(-2).join('/');

const printerForTemplate = (settings: AppSettings, layout: TemplateLayout) =>
  layout.printerName || settings.defaultPrinter;

const workflowForDesign = (layout: TemplateLayout, design: TemplateDesign | null): TemplateWorkflowSettings => {
  const shotCount = normalizePhotosToTake(layout.photosToTake, layout.photoWindows.length);
  return design?.workflowOverrideEnabled && design.workflowOverride
    ? normalizeTemplateWorkflow(design.workflowOverride, shotCount)
    : normalizeTemplateWorkflow(layout.workflowDefaults, shotCount);
};

const aiQueueStatusLabel = (item: AiQueueItem) => {
  if (item.status === 'queued') return 'QUEUED';
  if (item.status === 'generating') return 'GENERATING IMAGE';
  if (item.status === 'requested') return 'REQUEST SENT - WAITING FOR RESPONSE';
  if (item.status === 'done') return 'IMAGE GENERATED SUCCESSFULLY';
  if (item.status === 'printed') return 'IMAGE GENERATED AND PRINTED';
  if (item.status === 'print_failed') return 'IMAGE GENERATED - PRINT FAILED';
  if (item.status === 'failed') return 'IMAGE GENERATION FAILED';
  return 'AI JOB';
};

type CameraControlKey = keyof CameraControlSettings;

const CAMERA_CONTROL_FIELDS: Array<{ key: CameraControlKey; label: string }> = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'sharpness', label: 'Sharpness' },
  { key: 'exposureCompensation', label: 'Exposure' },
  { key: 'zoom', label: 'Zoom' }
];

const isRangeCapability = (value: unknown): value is CameraRangeCapability => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CameraRangeCapability>;
  return typeof candidate.min === 'number' && typeof candidate.max === 'number';
};

const getCameraCapabilities = (stream: MediaStream): CameraCapabilitiesMap => {
  const track = stream.getVideoTracks()[0];
  if (!track?.getCapabilities) return {};
  const rawCapabilities = track.getCapabilities() as Record<string, unknown>;
  return CAMERA_CONTROL_FIELDS.reduce<CameraCapabilitiesMap>((next, field) => {
    const capability = rawCapabilities[field.key];
    if (isRangeCapability(capability)) next[field.key] = capability;
    return next;
  }, {});
};

const getCameraControlSettings = (stream: MediaStream | null): CameraControlSettings => {
  const track = stream?.getVideoTracks()[0];
  if (!track?.getSettings) return {};
  const settings = track.getSettings() as Record<string, unknown>;
  return CAMERA_CONTROL_FIELDS.reduce<CameraControlSettings>((next, field) => {
    const value = settings[field.key];
    if (typeof value === 'number') next[field.key] = value;
    return next;
  }, {});
};

const getManualCameraDefaults = (capabilities: CameraCapabilitiesMap): CameraControlSettings =>
  CAMERA_CONTROL_FIELDS.reduce<CameraControlSettings>((next, field) => {
    const capability = capabilities[field.key];
    if (capability) {
      const requestedValue = field.key === 'zoom' ? 0 : 50;
      next[field.key] = Math.min(capability.max, Math.max(capability.min, requestedValue));
      return next;
    }
    if (SOFTWARE_CAMERA_KEYS.includes(field.key as SoftwareCameraKey)) {
      next[field.key] = SOFTWARE_CAMERA_DEFAULT;
    }
    return next;
  }, {});

const defaultCameraControlValue = (capability: CameraRangeCapability) => (capability.min + capability.max) / 2;

const applyCameraControls = async (stream: MediaStream, controls: CameraControlSettings) => {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track?.applyConstraints || !track.getCapabilities) return;
    const capabilities = getCameraCapabilities(stream);
    const advanced = CAMERA_CONTROL_FIELDS.reduce<Record<string, number>>((next, field) => {
      const value = controls[field.key];
      const capability = capabilities[field.key];
      if (typeof value === 'number' && capability) {
        next[field.key] = Math.min(capability.max, Math.max(capability.min, value));
      }
      return next;
    }, {});
    if (Object.keys(advanced).length === 0) return;
    await track.applyConstraints({ advanced: [advanced as MediaTrackConstraintSet] });
  } catch (error) {
    console.warn('Camera controls are not supported by this device.', error);
  }
};

const toggleSelectedIndex = (current: number[], index: number, maxCount: number) => {
  if (current.includes(index)) return current.filter((item) => item !== index);
  return [...current, index].slice(-maxCount);
};

const slotGuideStyle = (slot: Pick<TemplateSlot, 'width' | 'height' | 'cropY' | 'rotation'>) => {
  const rotated = slot.rotation === 90 || slot.rotation === 270;
  const width = rotated ? slot.height : slot.width;
  const height = rotated ? slot.width : slot.height;
  return {
    aspectRatio: `${width} / ${height}`,
    '--slot-aspect': width / height
  } as CSSProperties;
};

const createPickerPlaceholderCaptures = (settings: AppSettings): Capture[] =>
  Array.from({ length: 4 }, (_item, index) => {
    const isPortrait = isPortraitCamera(settings);
    const canvas = document.createElement('canvas');
    canvas.width = isPortrait ? 900 : 1600;
    canvas.height = isPortrait ? 1600 : 900;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
      ctx.fillStyle = '#fff';
      ctx.font = '300 54px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`PHOTO ${index + 1}`, canvas.width / 2, canvas.height / 2);
    }
    return {
      dataUrl: canvas.toDataURL('image/png'),
      path: `picker-placeholder-${index}`,
      name: `placeholder-${index + 1}.png`
    };
  });

const getCameraVideoClass = (settings: AppSettings) =>
  [
    'camera-video',
    settings.mirrorPreview ? 'mirror' : '',
    settings.cameraRotation ? `camera-rotate-${settings.cameraRotation}` : ''
  ]
    .filter(Boolean)
    .join(' ');

const isPortraitCamera = (settings: AppSettings) => settings.cameraRotation === 90 || settings.cameraRotation === 270;

const getCameraOrientationClass = (settings: AppSettings) =>
  isPortraitCamera(settings) ? 'camera-placeholder-portrait' : 'camera-placeholder-landscape';
