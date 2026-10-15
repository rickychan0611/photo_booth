import { needsGroupSelection, photoForMode, NORMAL_PHOTO_MESSAGE, type SessionMode } from '../electron/sessionMode';
import { previewImages } from './previewImages';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type InputHTMLAttributes } from 'react';
import QRCode from 'qrcode';
import { ArrowLeft, ArrowUp, Camera, Copy, Download, Expand, ExternalLink, FolderOpen, Globe, Image, Minimize2, Printer, RefreshCw, RotateCw, Settings, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { AiPreset, AiProvider, AiQueueItem, AppSettings, AudioCue, BoothSession, CameraControlSettings, CameraRotation, Capture, CloudSyncStatus, Gallery, GalleryUploadStatus, QueueSnapshot, SavedPhoto, TemplateDesign, TemplateLayout, TemplateSlot, TemplateWorkflowSettings } from './types';
import { detectPhotoSlots, layoutFromDetectedSlots, loadRasterFromFile, renderSlotMapThumbnail } from './templateMap';
import { createGuideTemplateImage, createTemplatedPhotoLayer, createTemplatedPrintImageFromLayer, getPrimarySlot, MAX_PHOTOS_TO_TAKE, normalizePhotosToTake, normalizeTemplateLayoutForClient, normalizeTemplateWorkflow, templateDimensions } from './template';
import {
  getCameraVideoStyle,
  SOFTWARE_CAMERA_DEFAULT,
  SOFTWARE_CAMERA_KEYS,
  type CameraCapabilitiesMap,
  type CameraRangeCapability,
  type SoftwareCameraKey
} from './cameraImage';
import { GuestScreenLockProvider, KioskButton } from './KioskButton';
import { playAudioCue, playAudioCueObject, preloadAudioCue, stopAllAudio, stopAudioChannel, stopAudioCue } from './audio';
import { createBoothGallerySession, createQueueRealtimeClient, fetchQueueSnapshot, isRealtimeConfigured, isWebQueueConfigured, publicWebUrl, validateBoothCode } from './webBackend';
import { PoseGuideOverlay, type PoseGuideHandle } from './pose/PoseGuideOverlay';
import { GuestCompositionScreen, CompositionControls } from './pose/GuestCompositionScreen';
import { EMPTY_COMPOSITION, RandomSceneSelector, slotFraming, slotGeometry, validateComposition } from './pose/scenes';
import { loadPhotoGuideCatalog } from './pose/repository';
import { normalizePoseGuide, type GuestComposition, type PoseFraming, type PoseNarrationSettings, type PoseScene } from './pose/types';
import { validateScene } from './pose/validation';
const PoseEditor = lazy(() => import('./pose/editor/PoseEditor').then(module => ({ default: module.PoseEditor })));

type GuestStep = 'queue' | 'welcome' | 'style' | 'design' | 'mode' | 'people' | 'intro' | 'capture' | 'select' | 'thanks';

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

const buttonText = (value: string) => `[ ${value} ]`;
const PHONE_MAX_DIGITS = 15;
const SELECT_PREVIEW_MAX_LONG_EDGE = 600;
const ELEVENLABS_DEFAULTS: PoseNarrationSettings = { configured: false, voiceId: '0S5oIfi8zOZixuSj8K6n', modelId: 'eleven_v4_turbo', stability: .5, similarityBoost: .75, style: .2, speed: 1, direction: '[energetic] [happy] [Make it upbeat, fun]' };

const decodeImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new window.Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Canon Live View returned an unreadable frame.'));
  image.src = source;
});

async function openCanonLiveViewStream(signal: AbortSignal): Promise<MediaStream> {
  const connected = await window.photoBooth.canonConnect();
  if (!connected.ok) throw new Error(connected.error || 'Canon camera could not connect.');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Video canvas is unavailable.');
  let stream: MediaStream | null = null;
  let firstFrameResolve: (value: MediaStream) => void = () => undefined;
  let firstFrameReject: (reason?: unknown) => void = () => undefined;
  let firstFrameSettled = false;
  const firstFrame = new Promise<MediaStream>((resolve, reject) => {
    firstFrameResolve = resolve;
    firstFrameReject = reject;
  });

  void (async () => {
    try {
      while (!signal.aborted) {
        const startedAt = performance.now();
        const dataUrl = await window.photoBooth.canonLiveFrame();
        if (signal.aborted) break;
        if (dataUrl) {
          const image = await decodeImage(dataUrl);
          if (!canvas.width || canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          if (!stream) {
            stream = canvas.captureStream(24);
            firstFrameSettled = true;
            firstFrameResolve(stream);
          }
        }
        const remaining = 42 - (performance.now() - startedAt);
        if (remaining > 0) await delay(remaining);
      }
    } catch (error) {
      if (!firstFrameSettled) firstFrameReject(error);
      firstFrameSettled = true;
      console.warn('Canon USB Live View stopped.', error);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  })();

  signal.addEventListener('abort', () => {
    if (!firstFrameSettled) firstFrameReject(new DOMException('Canon Live View cancelled.', 'AbortError'));
    firstFrameSettled = true;
  }, { once: true });
  return firstFrame;
}

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
    return window.photoBooth.onSettingsChanged(setSettings);
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
  return <GuestApp />;
}

function GuestApp() {
  const query = new URLSearchParams(window.location.search);
  const shouldOpenPickerPreview = query.get('preview') === 'picker';
  const { settings } = useSettings();
  const [welcomeLogoSrc, setWelcomeLogoSrc] = useState('');
  const [step, setStep] = useState<GuestStep>('welcome');
  const [composition, setComposition] = useState<GuestComposition>({ ...EMPTY_COMPOSITION });
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  const modeTransitionRef = useRef(false);
  const pendingDesignRef = useRef<TemplateDesign | null>(null);
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
  const [pendingPrint, setPendingPrint] = useState<PendingPrint | null>(null);
  const [selectPreviewUrls, setSelectPreviewUrls] = useState<Record<number, string>>({});
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
  const captureGuideRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraAbortRef = useRef<AbortController | null>(null);
  const activeCameraSourceRef = useRef<AppSettings['cameraSource'] | null>(null);
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
  const thanksVoiceStartedRef = useRef(false);
  const pendingGalleryUploadRef = useRef<{ settings: AppSettings; session: BoothSession | null; finalPath: string } | null>(null);
  const pendingPhoneSubmissionRef = useRef<PendingPhoneSubmission | null>(null);
  const lastShortcutRef = useRef('');
  const sessionRunRef = useRef(0);
  const poseGuideRef = useRef<PoseGuideHandle>(null);
  const poseAbortRef = useRef<AbortController | null>(null);
  const [poseShot, setPoseShot] = useState({ number: 1, total: 1 });
  const [poseSessionEnabled, setPoseSessionEnabled] = useState(false);
  const [cameraPausedByAdmin, setCameraPausedByAdmin] = useState(false);
  const [poseGuestPreview, setPoseGuestPreview] = useState<{ scene: PoseScene; framing: PoseFraming } | null>(null);
  const queueModeEnabled = Boolean(settings?.staffControlQueueMode);
  const templateLayouts = settings?.template.layouts.map(normalizeTemplateLayoutForClient) ?? [];
  const activeTemplateLayouts = templateLayouts.filter((layout) => layout.active);
  const activeTemplateIds = new Set(activeTemplateLayouts.map((layout) => layout.id));
  const activeDesigns = settings?.template.designs.filter((design) => design.active && activeTemplateIds.has(design.templateId)) ?? [];
  const selectableTemplates = activeTemplateLayouts.filter((layout) =>
    activeDesigns.some((design) => design.templateId === layout.id)
  );
  const selectedTemplate = templateLayouts.find((layout) => layout.id === selectedTemplateId) ?? templateLayouts[0] ?? null;
  const selectedDesign = activeDesigns.find((design) => design.id === selectedDesignId) ?? null;
  const selectedWorkflow = settings && selectedTemplate ? workflowForTemplate(settings, selectedTemplate, sessionMode ?? 'fun') : null;

  useEffect(() => {
    if (!settings) return;
    const activeIds = new Set(settings.template.layouts.filter(layout => layout.active).map(layout => layout.id));
    for (const layout of settings.template.layouts) {
      if (layout.active) void previewImages.load(layout.guestPreviewPath, layout.updatedAt);
    }
    for (const design of settings.template.designs) {
      if (design.active && activeIds.has(design.templateId)) void previewImages.load(templatePreviewPath(design), design.updatedAt);
    }
  }, [settings?.template]);

  useEffect(() => {
    let active = true;
    const logoPath = settings?.template.logoPath;
    if (!logoPath) {
      setWelcomeLogoSrc('');
      return undefined;
    }
    setWelcomeLogoSrc('');
    void window.photoBooth
      .getImageDataUrl(logoPath)
      .then((dataUrl) => {
        if (active) setWelcomeLogoSrc(dataUrl);
      })
      .catch(() => {
        if (active) setWelcomeLogoSrc('');
      });
    return () => {
      active = false;
    };
  }, [settings?.template.logoPath]);

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
    return window.photoBooth.onGuestCameraPaused(paused => {
      setCameraPausedByAdmin(paused);
      if (paused) stopCamera();
    });
  }, []);

  useEffect(() => {
    if (!settings) return undefined;
    if (cameraPausedByAdmin) {
      stopCamera();
      return undefined;
    }
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
    if (settings && step !== 'thanks') void preloadAudioCue(settings, settings.audio.cues.thanks);
  }, [settings?.audio, step]);

  useEffect(() => {
    if (!settings) return;
    if (step !== 'thanks') thanksVoiceStartedRef.current = false;
    const cueByStep: Partial<Record<GuestStep, string>> = {
      welcome: 'welcome',
      style: 'style',
      design: 'design',
      mode: 'mode',
      people: 'people'
    };
    if (step !== 'welcome') stopAudioCue('welcome');
    if (step !== 'mode') stopAudioCue('mode');
    const cueId = cueByStep[step];
    if (cueId) void playAudioCue(settings, cueId);

    const layout = settings.template.layouts
      .map(normalizeTemplateLayoutForClient)
      .find((item) => item.id === selectedTemplateId);
    const workflow = layout ? workflowForTemplate(settings, layout) : null;

    if (step === 'intro') void playAudioCueObject(settings, workflow?.screenCues?.intro, workflow?.introMessage);
    if (step === 'select') void playAudioCueObject(settings, workflow?.screenCues?.select);
    if (step === 'thanks' && !thanksVoiceStartedRef.current) {
      thanksVoiceStartedRef.current = true;
      void playAudioCueObject(settings, workflow?.screenCues?.thanks, workflow?.thankYouMessage);
    }
    return () => { if (step === 'mode') stopAudioCue('mode'); };
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
    setSessionMode(null);
    setPoseSessionEnabled(false);
    modeTransitionRef.current = false;
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setSelectContext(null);
    setSelectCountdown(null);
    setPrintedPreview('');
    setPrintedNumber('');
    setPendingPrint(null);
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
    setStep(queueModeEnabled ? 'queue' : 'welcome');
  }, [queueModeEnabled, step, thankYouCountdown]);

  const resetGuestSession = () => {
    setComposition({ ...EMPTY_COMPOSITION });
    pendingDesignRef.current = null;
    poseAbortRef.current?.abort();
    poseAbortRef.current = null;
    poseGuideRef.current?.stop();
    setSessionMode(null);
    setPoseSessionEnabled(false);
    modeTransitionRef.current = false;
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setSelectContext(null);
    setSelectCountdown(null);
    setPrintedPreview('');
    setPrintedNumber('');
    setPendingPrint(null);
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

  const showPoseOnGuest = (preview: unknown) => {
    if (!preview || typeof preview !== 'object') return;
    const payload = preview as { scene?: unknown; framing?: unknown };
    const scene = validateScene(payload.scene);
    const framing: PoseFraming = payload.framing === 'half' ? 'half' : 'full';
    setPoseGuestPreview({ scene, framing });
    setPoseSessionEnabled(true);
    setPoseShot({ number: 1, total: 1 });
    setCountdown(null);
    setIsCapturing(false);
    setCaptureMessage('');
    setStep('capture');
  };

  const posePreviewTaken = useRef(false);
  useEffect(() => {
    if (!settings) return undefined;
    const queryPreview = new URLSearchParams(window.location.search).get('preview') === 'pose';
    if (queryPreview && !posePreviewTaken.current) {
      posePreviewTaken.current = true;
      void window.photoBooth.takePosePreview().then(preview => { if (preview) showPoseOnGuest(preview); });
    }
    return window.photoBooth.onPreviewPose(preview => { if (!poseAbortRef.current) showPoseOnGuest(preview); });
  }, [settings]);

  useEffect(() => {
    if (!poseGuestPreview || step !== 'capture') return undefined;
    const controller = new AbortController();
    let stopped = false;
    const run = async () => {
      try { await startCamera('preview'); } catch { /* The pose still plays if the camera is unavailable. */ }
      while (!stopped && !controller.signal.aborted) {
        const guide = poseGuideRef.current;
        if (!guide) { await delay(50); continue; }
        const result = await guide.play(poseGuestPreview.scene, controller.signal, poseGuestPreview.framing);
        if (stopped || controller.signal.aborted || result === 'cancelled') return;
        if (result !== 'completed') { setError('This pose could not be shown on the guest screen.'); return; }
        await guide.dismiss();
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); poseGuideRef.current?.stop(); };
  }, [poseGuestPreview, step]);

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
      poseAbortRef.current?.abort();
      poseGuideRef.current?.stop();
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
    cameraAbortRef.current?.abort();
    cameraAbortRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    activeCameraSourceRef.current = null;
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

  const openCameraStream = async (quality: 'preview' | 'capture') => {
    if (settings?.cameraSource === 'canon-usb') {
      const controller = new AbortController();
      cameraAbortRef.current?.abort();
      cameraAbortRef.current = controller;
      return openCanonLiveViewStream(controller.signal);
    }
    const preferred: MediaTrackConstraints = quality === 'preview'
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
    const relaxed: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const attempts: MediaStreamConstraints[] = [];
    const pushAttempt = (video: MediaTrackConstraints | boolean) => {
      attempts.push({ video, audio: false });
    };
    if (settings?.cameraId) {
      pushAttempt({ ...preferred, deviceId: { exact: settings.cameraId } });
    }
    pushAttempt(preferred);
    if (quality === 'capture') {
      if (settings?.cameraId) pushAttempt({ ...relaxed, deviceId: { exact: settings.cameraId } });
      pushAttempt(relaxed);
    }
    pushAttempt(true);

    let lastError: unknown;
    for (let index = 0; index < attempts.length; index += 1) {
      if (index > 0) await delay(400);
      try {
        return await navigator.mediaDevices.getUserMedia(attempts[index]);
      } catch (error) {
        lastError = error;
        console.warn('Camera open attempt failed.', error);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Camera not ready.');
  };

  const startCamera = async (quality: 'preview' | 'capture' = 'capture', options: { forceRestart?: boolean; runId?: number } = {}) => {
    if (!settings) throw new Error('Settings not ready.');
    if (streamRef.current && activeCameraSourceRef.current === settings.cameraSource && !options.forceRestart) {
      await attachCameraStream(streamRef.current);
      return;
    }
    stopCamera();
    const stream = await openCameraStream(quality);
    if (options.runId !== undefined && sessionRunRef.current !== options.runId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    setCameraCapabilities(getCameraCapabilities(stream));
    await applyCameraControls(stream, settings.cameraControls);
    if (options.runId !== undefined && sessionRunRef.current !== options.runId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    activeCameraSourceRef.current = settings.cameraSource;
    await attachCameraStream(stream);
  };

  useEffect(() => {
    if (!settings) return undefined;
    const needsPreviewCamera = step === 'welcome';
    const retainCamera = needsPreviewCamera || step === 'style' || step === 'design' || step === 'mode' || step === 'people' || step === 'intro' || step === 'capture';
    if (!retainCamera) {
      stopCamera();
      return undefined;
    }
    if (!needsPreviewCamera) return undefined;
    let active = true;
    void startCamera('preview').catch((error) => {
      if (active) console.warn('Guest camera preview unavailable.', error);
    });
    return () => {
      active = false;
    };
  }, [settings, step, cameraPausedByAdmin]);

  const pickRecorderMimeType = () => {
    const candidates = [
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
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

  // Captures the booth window (camera, countdown, and messages) plus the
  // microphone with a 1280-pixel long-edge limit. The capture stays temporary
  // until the outro writes the one saved video.
  const startSessionRecording = async () => {
    if (mediaRecorderRef.current || typeof MediaRecorder === 'undefined') return;
    try {
      const pixelWidth = Math.max(1, Math.round(window.innerWidth * window.devicePixelRatio));
      const pixelHeight = Math.max(1, Math.round(window.innerHeight * window.devicePixelRatio));
      const recordingScale = Math.min(1, 1280 / Math.max(pixelWidth, pixelHeight));
      const recordingWidth = Math.max(2, Math.floor(pixelWidth * recordingScale / 2) * 2);
      const recordingHeight = Math.max(2, Math.floor(pixelHeight * recordingScale / 2) * 2);
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 24, max: 24 },
          width: { ideal: recordingWidth, max: recordingWidth },
          height: { ideal: recordingHeight, max: recordingHeight }
        },
        audio: false
      });
      const videoTrack = displayStream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) videoTrack.contentHint = 'detail';
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
        videoBitsPerSecond: 5_000_000,
        audioBitsPerSecond: 128_000
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
      console.log('[video] saved locally at', saved.path);
      return saved.path;
      })
      .catch((error) => {
        console.warn('[video] could not finalize session recording.', error);
        stopRecordingTracks();
        return null;
      });
  };

  const scheduleSessionVideoOutro = (finalImagePath: string) => {
    const sourceSave = pendingVideoSaveRef.current;
    if (!sourceSave || !settings) return;
    pendingVideoPathRef.current = null;
    pendingVideoSaveRef.current = sourceSave.then(async (videoPath) => {
      if (!videoPath) return null;
      try {
        const completed = await window.photoBooth.appendSessionVideoOutro({
          videoPath,
          finalImagePath,
          logoPath: settings.template.logoPath
        });
        pendingVideoPathRef.current = completed.path;
        console.log('[video] final photo and logo outro added', { path: completed.path });
        return completed.path;
      } catch (error) {
        console.warn('[video] could not add final outro; using the session video.', error);
        pendingVideoPathRef.current = videoPath;
        return videoPath;
      }
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

  const captureFrame = async (slot: TemplateSlot, useFullLiveView = false, runId?: number) => {
    if (!videoRef.current || !settings) throw new Error('Camera not ready.');
    const assertCurrent = () => {
      if (runId !== undefined && sessionRunRef.current !== runId) throw new DOMException('Session cancelled.', 'AbortError');
    };
    assertCurrent();

    // Render the camera view directly from the camera's native resolution. A
    // plain window screenshot is capped by the guest screen's physical pixel
    // density, which is usually far lower than what the camera actually
    // captures -- that mismatch is what made prints look soft/blurry.
    setIsCapturing(true);
    poseGuideRef.current?.hide();
    await nextPaint();

    try {
      assertCurrent();
      const video = videoRef.current;
      if (settings.canonEnabled && !useFullLiveView) {
        if (!captureGuideRef.current || !video.videoWidth || !video.videoHeight) {
          throw new Error('Capture card is not ready.');
        }
        const frame = captureFrameGeometry(video, settings, window.innerWidth, window.innerHeight);
        const bounds = captureGuideRef.current.getBoundingClientRect();
        const captured = await window.photoBooth.canonCapture({
          x: bounds.left * frame.outputScale,
          y: bounds.top * frame.outputScale,
          width: bounds.width * frame.outputScale,
          height: bounds.height * frame.outputScale,
          frameWidth: frame.width,
          frameHeight: frame.height,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          rotation: settings.cameraRotation,
          mirror: settings.mirrorPreview,
          framing: settings.canonFraming === 'contain' ? 'contain' : 'cover',
          slotAspect: slotGeometry(slot).width / Math.max(1, slotGeometry(slot).height),
          cropY: slot.cropY === 'top' ? 'top' : 'center'
        });
        assertCurrent();
        const saved = await window.photoBooth.saveImage({ dataUrl: captured.dataUrl, kind: 'original', filenamePrefix: 'original' });
        assertCurrent();
        return { dataUrl: captured.dataUrl, ...saved };
      }

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
        assertCurrent();
      }

      // Cover-crop to the slot's exact aspect ratio so it drops into the print
      // frame without stretching, for every template style.
      const geometry = slotGeometry(slot);
      const finalDataUrl = await coverCropToAspect(dataUrl, geometry.width / geometry.height, slot.cropY);
      assertCurrent();
      setIsFlashing(true);
      window.setTimeout(() => setIsFlashing(false), 180);
      const saved = await window.photoBooth.saveImage({ dataUrl: finalDataUrl, kind: 'original', filenamePrefix: 'original' });
      assertCurrent();
      return { dataUrl: finalDataUrl, ...saved };
    } finally {
      if (runId === undefined || sessionRunRef.current === runId) setIsCapturing(false);
    }
  };

  const runCountdown = async (runId: number) => {
    for (const value of [3, 2, 1]) {
      if (sessionRunRef.current !== runId) return false;
      setCountdown(value);
      if (settings) void playAudioCue(settings, `countdown${value}`, String(value));
      const focus = value === 2 && settings?.canonEnabled
        ? window.photoBooth.canonPrepareCapture().catch((focusError) => {
          console.warn('Canon countdown autofocus was unavailable.', focusError);
        })
        : Promise.resolve();
      await Promise.all([delay(1000), focus]);
    }
    if (sessionRunRef.current !== runId) return false;
    setCountdown(null);
    return true;
  };

  const createProcessedPrintImage = async (
    request: PendingPrint,
    options: { maxLongEdge?: number } = {}
  ) => {
    if (!settings) return '';
    const layout = templateLayouts.find((item) => item.id === request.templateId);
    if (!layout) return '';
    const baseDataUrls = request.indexes
      .slice(0, layout.photoWindows.length)
      .map((index) => request.captures[index]?.dataUrl)
      .filter(Boolean) as string[];
    if (baseDataUrls.length < layout.photoWindows.length) return '';
    const photoDataUrls = settings.mirrorPreview
      ? await Promise.all(baseDataUrls.map(flipPhotoForPrint))
      : baseDataUrls;
    const photoLayer = await createTemplatedPhotoLayer(
      photoDataUrls,
      layout,
      options.maxLongEdge ? { maxLongEdge: options.maxLongEdge } : undefined
    );
    const templateDataUrl = await window.photoBooth.getImageDataUrl(templateFramePath(request.design));
    return createTemplatedPrintImageFromLayer(
      photoLayer,
      layout,
      request.design,
      templateDataUrl,
      options.maxLongEdge ? { maxLongEdge: options.maxLongEdge } : undefined
    );
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
    setSelectCountdown(null);
    if (settings) void playAudioCue(settings, 'button');
    void printCaptures(captures, final, context.templateId, context.design);
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

  useEffect(() => {
    if (step !== 'select' || !settings || captures.length === 0) {
      if (step !== 'select') setSelectPreviewUrls({});
      return undefined;
    }
    let active = true;
    void (async () => {
      try {
        const entries = await Promise.all(
          captures.map(async (capture, index) => {
            if (!capture.dataUrl) return [index, ''] as const;
            const source = settings.mirrorPreview ? await flipPhotoForPrint(capture.dataUrl) : capture.dataUrl;
            const thumb = await downscaleDataUrl(source, SELECT_PREVIEW_MAX_LONG_EDGE);
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
  }, [captures, settings, step]);

  const continueAfterDesignSelection = (design: TemplateDesign) => {
    setSelectedTemplateId(design.templateId);
    setSelectedDesignId(design.id);
    setSelectedCaptureIndexes([]);
    pendingDesignRef.current = design;
    setSessionMode(null);
    modeTransitionRef.current = false;
    setStep('mode');
  };

  const chooseMode = (mode: SessionMode) => {
    const design = pendingDesignRef.current;
    if (!settings || !design || step !== 'mode' || modeTransitionRef.current || isBusy) return;
    modeTransitionRef.current = true;
    stopAudioCue('mode');
    void playAudioCue(settings, 'button');
    setSessionMode(mode);
    const guide = normalizePoseGuide(settings.poseGuide);
    if (needsGroupSelection(mode, guide.selectionEnabled !== false)) setStep('people');
    else void startSession(design.templateId, design, guide.defaultComposition!, mode);
  };

  const stepBeforeSession = () => {
    const templateDesignCount = activeDesigns.filter((design) => design.templateId === selectedTemplateId).length;
    if (templateDesignCount > 1) return 'design' as const;
    if (selectableTemplates.length === 1) return 'welcome' as const;
    return 'style' as const;
  };

  const chooseTemplate = (templateId: string) => {
    if (settings) void playAudioCue(settings, 'button');
    const templateDesigns = activeDesigns.filter((design) => design.templateId === templateId);
    const firstDesign = templateDesigns[0];
    if (!firstDesign) {
      setSelectedTemplateId(templateId);
      setSelectedDesignId('');
      setSelectedCaptureIndexes([]);
      setStep('style');
      return;
    }
    if (templateDesigns.length === 1) {
      continueAfterDesignSelection(firstDesign);
      return;
    }
    setSelectedTemplateId(templateId);
    setSelectedDesignId(firstDesign.id);
    setSelectedCaptureIndexes([]);
    setStep('design');
  };

  const chooseDesign = (design: TemplateDesign) => {
    if (settings) void playAudioCue(settings, 'button');
    continueAfterDesignSelection(design);
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

  const startSession = async (templateId: string, design: TemplateDesign, guests: GuestComposition, mode: SessionMode) => {
    if (!settings || isBusy || poseAbortRef.current) return;
    const layout = templateLayouts.find((item) => item.id === templateId);
    if (!layout) return;
    const workflow = workflowForTemplate(settings, layout, mode);
    const guideEnabled = mode === 'fun';
    setSessionMode(mode);
    if (guideEnabled) {
      try { validateComposition(guests, normalizePoseGuide(settings.poseGuide).groupCapacity); }
      catch (error) { setError(String(error)); return; }
    }
    setPoseGuestPreview(null);
    setPoseSessionEnabled(guideEnabled);
    const runId = sessionRunRef.current + 1;
    sessionRunRef.current = runId;
    const poseController = new AbortController();
    poseAbortRef.current = poseController;
    setError('');
    setIsBusy(true);
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setSelectContext(null);
    setSelectCountdown(null);
    setPrintedPreview('');
    setPrintedNumber('');
    setPendingPrint(null);
    setIsAiGenerating(false);
    setCaptureMessage('');
    setCountdown(null);
    confirmPrintLockRef.current = false;

    try {
      const catalog = guideEnabled ? await loadPhotoGuideCatalog() : { poses: [], errors: [] };
      if (sessionRunRef.current !== runId) return;
      const selector = new RandomSceneSelector(structuredClone(catalog.poses));
      const sessionGuests = { ...guests };
      setComposition({ ...EMPTY_COMPOSITION });
      pendingDesignRef.current = null;
      setStep('intro');
      await delay(workflow.introMs);
      if (sessionRunRef.current !== runId) return;
      setStep('capture');
      await delay(100);
      if (sessionRunRef.current !== runId) return;
      await startCamera('capture', { forceRestart: true, runId });
      if (sessionRunRef.current !== runId) {
        return;
      }
      if (settings.canonEnabled) {
        const canon = await window.photoBooth.canonConnect();
        if (!canon.ok) throw new Error(canon.error || 'Could not connect to the Canon camera.');
      }
      if (design?.videoRecordingEnabled) {
        await startSessionRecording();
      }

      const slotCount = layout.photoWindows.length;
      const takeCount = normalizePhotosToTake(layout.photosToTake, slotCount);
      const pickMode = Boolean(design) && takeCount > slotCount;
      const shotPlan = Array.from({ length: takeCount }, (_item, index) => workflow.shots[index % workflow.shots.length]);
      const nextCaptures: Capture[] = [];

      for (const [shotIndex, shot] of shotPlan.entries()) {
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage('');
        setPoseShot({ number: shotIndex + 1, total: takeCount });
        const guideSlot = pickMode ? getPrimarySlot(layout, 0) : getPrimarySlot(layout, nextCaptures.length);
        const framing = slotFraming(guideSlot);
        const pose = guideEnabled ? selector.next(sessionGuests, framing) : null;
        let guided = false;
        if (pose && poseGuideRef.current) {
          stopAudioChannel('voice');
          const opening = shot.message;
          const openingCue = shot.audioCue;
          setCaptureMessage(opening);
          void playAudioCueObject(settings, openingCue ? { ...openingCue, text: opening } : undefined, opening);
          await delay(Math.max(700, shot.messageMs));
          if (sessionRunRef.current !== runId) return;
          setCaptureMessage('');
          const result = await poseGuideRef.current.play(pose, poseController.signal, framing);
          if (sessionRunRef.current !== runId || result === 'cancelled') return;
          guided = result === 'completed';
        }
        if (!guided) {
          poseGuideRef.current?.stop();
          await delay(shot.cameraBeforeMessageMs);
          if (sessionRunRef.current !== runId) return;
          setCaptureMessage(shot.message);
          void playAudioCueObject(settings, shot.audioCue, shot.message);
          setCaptureMessageFadeMs(shot.messageMs);
          await delay(shot.messageMs);
          if (sessionRunRef.current !== runId) return;
          setCaptureMessage('');
          await delay(shot.cameraBeforeCountdownMs);
        }
        if (sessionRunRef.current !== runId) return;
        if (guided) {
          await poseGuideRef.current?.dismiss();
          await nextPaint();
        }
        if (!(await runCountdown(runId))) {
          if (settings.canonEnabled) void window.photoBooth.canonReleaseFocus().catch(() => undefined);
          return;
        }
        poseGuideRef.current?.hide();
        void playAudioCue(settings, 'shutter');
        setIsFlashing(true);
        window.setTimeout(() => setIsFlashing(false), 180);
        // When taking more photos than slots, every shot is a candidate for any
        // slot, so crop them all to the first slot's aspect ratio for a
        // consistent selection grid. Otherwise match each slot in order.
        const capture = await captureFrame(guideSlot, false, runId);
        if (sessionRunRef.current !== runId) return;
        nextCaptures.push(capture);
        setCaptures([...nextCaptures]);
        await delay(350);
      }

      if (sessionRunRef.current !== runId) return;

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
        await printCaptures(nextCaptures, defaultIndexes, layout.id, design);
      } else {
        setStep('thanks');
      }
    } catch (error) {
      if (sessionRunRef.current !== runId) return;
      console.error('Photo session failed.', error);
      stopSessionRecording();
      stopCamera();
      const message = error instanceof Error ? error.message : 'Photo session failed.';
      setError(message);
      setCaptureMessage('');
      setCountdown(null);
      setSessionMode(null);
      setPoseSessionEnabled(false);
      pendingDesignRef.current = null;
      modeTransitionRef.current = false;
      setStep(selectableTemplates.length > 1 ? 'style' : 'welcome');
    } finally {
      if (poseAbortRef.current === poseController) {
        poseController.abort();
        poseAbortRef.current = null;
      }
      if (sessionRunRef.current === runId) {
        poseGuideRef.current?.stop();
        setCaptureMessage('');
        setCountdown(null);
        setIsBusy(false);
      }
    }
  };

  const printCaptures = async (
    sourceCaptures: Capture[],
    indexes: number[],
    templateId: string,
    design: TemplateDesign,
    processedPrintDataUrl?: string
  ) => {
    if (confirmPrintLockRef.current) return;
    confirmPrintLockRef.current = true;
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
    thanksVoiceStartedRef.current = true;
    const voiceStarted = playAudioCue(settings, 'thanks').catch(error => {
      console.warn('Phone entry voice could not play.', error);
    });
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

      let dataUrl = processedPrintDataUrl || await createProcessedPrintImage(request);
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
          scheduleSessionVideoOutro(result.saved.path);
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
      scheduleSessionVideoOutro(saved.path);
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
      // play() resolves once playback starts, without waiting for the narration to finish.
      await voiceStarted;
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

  const cancelRunningSession = () => {
    setSessionMode(null);
    setPoseSessionEnabled(false);
    modeTransitionRef.current = false;
    sessionRunRef.current += 1;
    poseAbortRef.current?.abort();
    poseAbortRef.current = null;
    poseGuideRef.current?.stop();
    stopSessionRecording();
    stopCamera();
    stopAllAudio();
    if (settings?.canonEnabled) void window.photoBooth.canonReleaseFocus().catch(() => undefined);
    setCountdown(null);
    setCaptureMessage('');
    setIsCapturing(false);
    setIsBusy(false);
    setIsFlashing(false);
    setSelectCountdown(null);
  };

  const goBack = () => {
    if (settings) void playAudioCue(settings, 'button');
    if (step === 'welcome') {
      setStep('queue');
      return;
    }
    if (step === 'style') {
      setStep('welcome');
      return;
    }
    if (step === 'design') {
      setStep(selectableTemplates.length === 1 ? 'welcome' : 'style');
      return;
    }
    if (step === 'mode') {
      setSessionMode(null);
      pendingDesignRef.current = null;
      setStep(stepBeforeSession());
      return;
    }
    if (step === 'people') {
      modeTransitionRef.current = false;
      setSessionMode(null);
      setStep('mode');
      return;
    }
    if (step === 'intro' || step === 'capture') {
      cancelRunningSession();
      setComposition({ ...EMPTY_COMPOSITION });
      pendingDesignRef.current = null;
      setStep(stepBeforeSession());
      return;
    }
    if (step === 'select') {
      setSelectCountdown(null);
      setStep(stepBeforeSession());
      return;
    }
    if (step === 'thanks') {
      if (!phoneSubmitted) {
        confirmPrintLockRef.current = false;
        setIsBusy(false);
        setIsFinalPreparing(false);
        setStep(selectContext ? 'select' : stepBeforeSession());
        return;
      }
      resetGuestSession();
    }
  };

  const showGuestBack = step !== 'queue' && !(step === 'welcome' && !queueModeEnabled);

  if (!settings) return <GuestShell><p className="quiet">LOADING</p></GuestShell>;

  const guestCameraStyle = getCameraVideoStyle(settings.cameraControls, cameraCapabilities);

  return (
    <GuestScreenLockProvider step={step}>
    <GuestShell flash={isFlashing} compactTop={step === 'queue'} thanksLayout={step === 'thanks'}>
      {showGuestBack && (
        <KioskButton className="guest-back-button" onPress={goBack}>
          {buttonText('BACK')}
        </KioskButton>
      )}
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
            {welcomeLogoSrc && <img className="welcome-logo" src={welcomeLogoSrc} alt="Event logo" />}
            <p className="welcome-tagline">welcome</p>
          </div>
        </section>
      )}

      {step === 'style' && (
        <section className="template-guest-screen">
          <p className="instruction">CHOOSE A TEMPLATE</p>
          {selectableTemplates.length === 0 && <p className="quiet">ASK ADMIN TO ADD A TEMPLATE</p>}
          <div className="style-card-grid">
            {selectableTemplates.map((layout) => {
              const count = activeDesigns.filter((design) => design.templateId === layout.id).length;
              const shots = normalizePhotosToTake(layout.photosToTake, layout.photoWindows.length);
              return (
                <KioskButton key={layout.id} className="style-card" onPress={() => chooseTemplate(layout.id)} disabled={count === 0}>
                  <TemplateGuestPreview layout={layout} />
                  <span>{layout.name.toUpperCase()}</span>
                  <small>{shots} SHOT{shots === 1 ? '' : 'S'}</small>
                </KioskButton>
              );
            })}
          </div>
        </section>
      )}

      {step === 'design' && (
        <section className="template-guest-screen">
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

      {step === 'mode' && (
        <section className="mode-screen" aria-labelledby="mode-heading">
          <h1 id="mode-heading">Choose your photo experience</h1>
          <div className="mode-card-grid">
            <KioskButton className="mode-card" onPress={() => chooseMode('fun')} disabled={isBusy}>
              <img src={`${import.meta.env.BASE_URL}mode-images/fun-pose.png`} alt="" draggable={false} />
              <span>Fun Pose Challenge</span>
              <small>Match the poses on screen!</small>
            </KioskButton>
            <KioskButton className="mode-card" onPress={() => chooseMode('normal')} disabled={isBusy}>
              <img src={`${import.meta.env.BASE_URL}mode-images/freestyle.png`} alt="" draggable={false} />
              <span>Freestyle</span>
              <small>Pose your own way!</small>
            </KioskButton>
          </div>
        </section>
      )}

      {step === 'people' && (
        <GuestCompositionScreen value={composition} onChange={setComposition} capacity={normalizePoseGuide(settings.poseGuide).groupCapacity!} onContinue={() => {
          const design = pendingDesignRef.current;
          if (design && sessionMode) void startSession(design.templateId, design, { ...composition }, sessionMode);
        }} />
      )}

      {step === 'intro' && (
        <section className="welcome-screen">
          <p className="brand">{(selectedWorkflow?.introMessage ?? settings.workflow.introMessage).toUpperCase()}</p>
        </section>
      )}

      {step === 'capture' && (
        <section className="capture-screen">
          <video ref={videoRef} className={getCameraVideoClass(settings)} style={guestCameraStyle} playsInline muted />
          {poseSessionEnabled && (
            <PoseGuideOverlay ref={poseGuideRef} settings={settings} countdown={countdown} capturing={isCapturing} photoNumber={poseShot.number} photoCount={poseShot.total} />
          )}
          {/* {!isCapturing && (
            <div className="capture-progress">
              {selectedTemplate ? `${Math.min(captures.length + 1, selectedTemplate.photoWindows.length)} / ${selectedTemplate.photoWindows.length}` : '0 / 0'}
            </div>
          )} */}
          <div ref={captureGuideRef} className="capture-guide-layer" style={slotGuideStyle(getPrimarySlot(selectedTemplate, selectedTemplate && selectedDesign && normalizePhotosToTake(selectedTemplate.photosToTake, selectedTemplate.photoWindows.length) > selectedTemplate.photoWindows.length ? 0 : captures.length))}>
            {!isCapturing && <div className="capture-print-guide" />}
          </div>
          {captureMessage && (
            <div className="capture-message" style={{ '--message-fade-ms': `${captureMessageFadeMs}ms` } as CSSProperties}>
              <span style={{ whiteSpace: 'pre-line' }}>{captureMessage.replace(/\\n/g, '\n')}</span>
            </div>
          )}
          {poseGuestPreview && <button className="pose-guest-exit" onClick={() => { setPoseGuestPreview(null); setPoseSessionEnabled(false); poseGuideRef.current?.stop(); setStep('welcome'); }}>Exit</button>}
          {countdown && (
            <>
              <div className="capture-camera-arrow" aria-hidden="true">
                <ArrowUp strokeWidth={2.25} />
                <span className="capture-camera-label">LOOK HERE!</span>
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

      {step === 'thanks' && (
        <section className="thanks-screen">
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
                <p className="thanks-copy">Enter your phone # to access / share your photo at <span className="thanks-site">vibobooth.com</span>.</p>
                <div className="phone-entry-display">{formatPhoneNumber(phoneNumber) || 'Phone number'}</div>
                <p className="phone-entry-hint">Please press slowly. The sensor may be delayed.</p>
                <DigitKeypad
                  className="phone-keypad"
                  disabled={isBusy}
                  value={phoneNumber}
                  onDigit={(digit) => {
                    void playAudioCue(settings, 'button');
                    appendPhoneDigit(digit);
                  }}
                  onClear={() => {
                    void playAudioCue(settings, 'button');
                    setPhoneNumber('');
                    setPhoneEntryMessage('');
                  }}
                  onBackspace={() => {
                    void playAudioCue(settings, 'button');
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
                    className="booth-button phone-skip-button"
                    onPress={skipPhoneEntry}
                    disabled={isBusy}
                  >
                    Skip
                  </KioskButton>
                  <KioskButton
                    className={`booth-button phone-submit-button${
                      !isBusy &&
                      phoneNumber.replace(/\D/g, '').length >= 7 &&
                      (galleryConsent || marketingConsent)
                        ? ' ready'
                        : ''
                    }`}
                    onPress={submitPhoneNumber}
                    disabled={
                      isBusy ||
                      phoneNumber.replace(/\D/g, '').length < 7 ||
                      (!galleryConsent && !marketingConsent)
                    }
                  >
                    Submit
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
  const useIcons = className.includes('phone-keypad');
  return (
    <div className={`queue-keypad${className ? ` ${className}` : ''}`}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
        <KioskButton key={digit} onPress={() => onDigit(digit)} disabled={disabled}>
          {digit}
        </KioskButton>
      ))}
      <KioskButton
        className={useIcons ? 'phone-key-icon-button' : undefined}
        onPress={onClear}
        disabled={disabled || !value}
        aria-label="Clear"
      >
        {useIcons ? <X size={22} strokeWidth={2} /> : 'Clear'}
      </KioskButton>
      <KioskButton onPress={() => onDigit('0')} disabled={disabled}>
        0
      </KioskButton>
      <KioskButton
        className={useIcons ? 'phone-key-icon-button' : undefined}
        onPress={onBackspace}
        disabled={disabled || !value}
        aria-label="Back"
      >
        {useIcons ? <ArrowLeft size={22} strokeWidth={2} /> : 'Back'}
      </KioskButton>
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
  thanksLayout = false
}: {
  children: React.ReactNode;
  flash?: boolean;
  compactTop?: boolean;
  thanksLayout?: boolean;
}) {
  return (
    <main
      className={[
        'guest-shell',
        compactTop ? 'compact-top' : '',
        thanksLayout ? 'thanks-layout' : ''
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

function usePreviewImage(path: string, version: string) {
  const [loaded, setLoaded] = useState({ path: '', version: '', src: '' });
  useEffect(() => {
    let active = true;
    void previewImages.load(path, version).then(src => {
      if (active) setLoaded({ path, version, src });
    });
    return () => { active = false; };
  }, [path, version]);
  return previewImages.peek(path, version) || (loaded.path === path && loaded.version === version ? loaded.src : '');
}

function TemplateGuestPreview({ layout }: { layout: TemplateLayout }) {
  const src = usePreviewImage(layout.guestPreviewPath, layout.updatedAt);

  if (src) {
    return (
      <div className={`template-guest-preview ${layout.orientation}`}>
        <img src={src} alt={layout.name} />
      </div>
    );
  }
  return <TemplateMini layout={layout} />;
}

function TemplateImagePreview({ design }: { design: TemplateDesign }) {
  const src = usePreviewImage(templatePreviewPath(design), design.updatedAt);

  return <div className="design-preview">{src ? <img src={src} alt={design.name} /> : null}</div>;
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

function TemplateDesignAdminCard({
  design,
  settings,
  onSave,
  onUpdateAsset,
  onDelete
}: {
  design: TemplateDesign;
  settings: AppSettings;
  onSave: (design: TemplateDesign) => Promise<void>;
  onUpdateAsset: (design: TemplateDesign, role: 'preview' | 'frame') => Promise<void>;
  onDelete: (design: TemplateDesign) => Promise<void>;
}) {
  return (
    <article className="template-design-admin">
      <TemplateImagePreview design={design} />
      <DraftInput value={design.name} onSave={(value) => onSave({ ...design, name: value })} />
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
  const [selectedWindowIndexes, setSelectedWindowIndexes] = useState<number[]>([]);
  const [guideImage, setGuideImage] = useState<{ src: string; name: string } | null>(null);
  const [guideVisible, setGuideVisible] = useState(true);
  const [guideOpacity, setGuideOpacity] = useState(50);
  const [drag, setDrag] = useState<null | {
    id: number;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    slot: TemplateSlot;
  }>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const guideInputRef = useRef<HTMLInputElement>(null);

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
    setSelectedWindowIndexes((selected) => selected.map((selectedIndex) => selectedIndex > index ? selectedIndex + 1 : selectedIndex));
  };

  const removeWindow = (index: number) => {
    updateWindows((windows) => windows.filter((_item, itemIndex) => itemIndex !== index));
    setSelectedWindowIndexes((selected) => selected[0] === index
      ? []
      : selected
        .filter((selectedIndex) => selectedIndex !== index)
        .map((selectedIndex) => selectedIndex > index ? selectedIndex - 1 : selectedIndex));
  };

  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));

  const alignSelected = (alignment: 'left' | 'horizontalCenter' | 'right' | 'top' | 'verticalCenter' | 'bottom') => {
    updateWindows((windows) => {
      const [masterIndex, ...followerIndexes] = selectedWindowIndexes;
      const master = windows[masterIndex];
      if (!master || followerIndexes.length === 0) return windows;
      const followers = new Set(followerIndexes);
      return windows.map((slot, index) => {
        if (!followers.has(index)) return slot;
        if (alignment === 'left') return { ...slot, x: clamp(master.x, layout.paperWidth - slot.width) };
        if (alignment === 'horizontalCenter') return { ...slot, x: clamp(master.x + (master.width - slot.width) / 2, layout.paperWidth - slot.width) };
        if (alignment === 'right') return { ...slot, x: clamp(master.x + master.width - slot.width, layout.paperWidth - slot.width) };
        if (alignment === 'top') return { ...slot, y: clamp(master.y, layout.paperHeight - slot.height) };
        if (alignment === 'verticalCenter') return { ...slot, y: clamp(master.y + (master.height - slot.height) / 2, layout.paperHeight - slot.height) };
        return { ...slot, y: clamp(master.y + master.height - slot.height, layout.paperHeight - slot.height) };
      });
    });
  };

  const matchSelectedDimension = (dimension: 'width' | 'height') => {
    updateWindows((windows) => {
      const [masterIndex, ...followerIndexes] = selectedWindowIndexes;
      const master = windows[masterIndex];
      if (!master || followerIndexes.length === 0) return windows;
      const followers = new Set(followerIndexes);
      return windows.map((slot, index) => {
        if (!followers.has(index)) return slot;
        if (dimension === 'width') {
          return {
            ...slot,
            width: master.width,
            x: clamp(slot.x, layout.paperWidth - master.width)
          };
        }
        return {
          ...slot,
          height: master.height,
          y: clamp(slot.y, layout.paperHeight - master.height)
        };
      });
    });
  };

  const toggleWindowSelection = (index: number) => {
    setSelectedWindowIndexes((selected) => {
      if (selected[0] === index) return selected;
      return selected.includes(index)
        ? selected.filter((selectedIndex) => selectedIndex !== index)
        : [...selected, index];
    });
  };

  const openGuidePicker = () => {
    if (!guideInputRef.current) return;
    guideInputRef.current.value = '';
    guideInputRef.current.click();
  };

  const loadGuideImage = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setGuideImage({ src: reader.result, name: file.name });
      setGuideVisible(true);
    };
    reader.readAsDataURL(file);
  };

  const removeGuideImage = () => {
    setGuideImage(null);
    if (guideInputRef.current) guideInputRef.current.value = '';
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
  const selectionReady = selectedWindowIndexes.length >= 2;

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
          <section className="template-selection-tools" aria-label="Photo window alignment">
            <div>
              <strong>Align selection</strong>
              <span>{selectionReady ? `Master + ${selectedWindowIndexes.length - 1} follower${selectedWindowIndexes.length === 2 ? '' : 's'}` : 'Shift-click a master, then followers'}</span>
            </div>
            <div className="template-alignment-grid">
              <button disabled={!selectionReady} onClick={() => alignSelected('left')}>Left</button>
              <button disabled={!selectionReady} onClick={() => alignSelected('horizontalCenter')}>H center</button>
              <button disabled={!selectionReady} onClick={() => alignSelected('right')}>Right</button>
              <button disabled={!selectionReady} onClick={() => alignSelected('top')}>Top</button>
              <button disabled={!selectionReady} onClick={() => alignSelected('verticalCenter')}>V center</button>
              <button disabled={!selectionReady} onClick={() => alignSelected('bottom')}>Bottom</button>
            </div>
            <div className="template-match-grid">
              <button disabled={!selectionReady} onClick={() => matchSelectedDimension('width')}>Match width</button>
              <button disabled={!selectionReady} onClick={() => matchSelectedDimension('height')}>Match height</button>
            </div>
          </section>
          <section className="template-guide-tools" aria-label="Tracing guide">
            <div>
              <strong>Tracing guide</strong>
              <span>{guideImage?.name ?? 'Session only — never saved'}</span>
            </div>
            <input
              ref={guideInputRef}
              className="template-guide-input"
              type="file"
              accept="image/*"
              onChange={(event) => loadGuideImage(event.target.files?.[0])}
            />
            <button onClick={openGuidePicker}>{guideImage ? 'Replace guide' : 'Upload guide'}</button>
            {guideImage && (
              <>
                <button onClick={() => setGuideVisible((visible) => !visible)}>{guideVisible ? 'Hide guide' : 'Show guide'}</button>
                <label className="template-guide-opacity">
                  Opacity {guideOpacity}%
                  <input type="range" min="5" max="100" value={guideOpacity} onChange={(event) => setGuideOpacity(Number(event.target.value))} />
                </label>
                <button onClick={removeGuideImage}>Remove guide</button>
              </>
            )}
          </section>
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
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              setSelectedWindowIndexes([]);
              setDrag(null);
            }}
          >
            {guideImage && guideVisible && (
              <img
                className="template-guide-image"
                src={guideImage.src}
                alt=""
                draggable={false}
                style={{ opacity: guideOpacity / 100 }}
              />
            )}
            {layout.photoWindows.map((slot, index) => (
              <div
                key={index}
                className={`template-window-box${selectedWindowIndexes[0] === index ? ' is-master' : selectedWindowIndexes.includes(index) ? ' is-follower' : ''}${guideImage && guideVisible ? ' has-guide' : ''}`}
                style={{
                  left: `${(slot.x / layout.paperWidth) * 100}%`,
                  top: `${(slot.y / layout.paperHeight) * 100}%`,
                  width: `${(slot.width / layout.paperWidth) * 100}%`,
                  height: `${(slot.height / layout.paperHeight) * 100}%`
                }}
                onPointerDown={(event) => {
                  if (event.shiftKey) {
                    event.preventDefault();
                    toggleWindowSelection(index);
                    setDrag(null);
                    return;
                  }
                  const point = paperPoint(event);
                  setDrag({ id: index, mode: 'move', startX: point.x, startY: point.y, slot });
                }}
              >
                <span className="template-window-number">{index + 1}</span>
                {selectedWindowIndexes[0] === index && <span className="template-window-selection-role">Master</span>}
                {selectedWindowIndexes[0] !== index && selectedWindowIndexes.includes(index) && <span className="template-window-selection-role">Follower</span>}
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
                  onClick={() => removeWindow(index)}
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
  const [elevenLabs, setElevenLabs] = useState<PoseNarrationSettings>(ELEVENLABS_DEFAULTS);
  const [elevenLabsApiKey, setElevenLabsApiKey] = useState('');
  const [gallerySearch, setGallerySearch] = useState('');
  const [cameraCapabilities, setCameraCapabilities] = useState<CameraCapabilitiesMap>({});
  const [cameraDefaultControls, setCameraDefaultControls] = useState<CameraControlSettings>({});
  const [selectedAdminTemplateId, setSelectedAdminTemplateId] = useState('');
  const [templateListGroupsOpen, setTemplateListGroupsOpen] = useState({ active: true, inactive: true });
  const [editingTemplate, setEditingTemplate] = useState<TemplateLayout | null>(null);
  const [selectedWorkflowShotIndex, setSelectedWorkflowShotIndex] = useState(0);
  const [aiPresetDraft, setAiPresetDraft] = useState({ name: '', prompt: '' });
  const [galleryUploadStatus, setGalleryUploadStatus] = useState<GalleryUploadStatus>({
    state: 'idle',
    message: 'No active upload.',
    active: 0
  });
  const [cloudSyncStatus, setCloudSyncStatus] = useState<CloudSyncStatus>({
    state: 'idle',
    message: 'Cloud sync is ready.'
  });
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const slotMapInputRef = useRef<HTMLInputElement>(null);
  const [adminStream, setAdminStream] = useState<MediaStream | null>(null);
  const [canonStatus, setCanonStatus] = useState('');

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
    void window.photoBooth.getCloudSyncStatus().then(setCloudSyncStatus);
    void window.photoBooth.getPoseNarrationSettings().then(setElevenLabs).catch(error => setMessage(String(error)));
    const removeGalleryListener = window.photoBooth.onGalleryUploadStatus((status) => {
      setGalleryUploadStatus(status);
      if (status.state === 'done' || status.state === 'failed') void refreshGallery();
    });
    const removeSyncListener = window.photoBooth.onCloudSyncStatus(setCloudSyncStatus);
    return () => {
      removeGalleryListener();
      removeSyncListener();
    };
  }, []);

  useEffect(() => {
    if (tab === 'gallery') void refreshGallery();
    if (tab === 'aiQueue') void refreshAiQueue();
  }, [tab]);

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
    let active = true;
    const controller = new AbortController();
    const start = async () => {
      try {
        await window.photoBooth.setGuestCameraPaused(true);
        await delay(350);
        if (!active) return;
        stream = settings.cameraSource === 'canon-usb'
          ? await openCanonLiveViewStream(controller.signal)
          : await navigator.mediaDevices.getUserMedia({
              video: settings.cameraId ? { deviceId: { exact: settings.cameraId } } : true,
              audio: false
            });
        if (settings.cameraSource === 'capture-card') {
          setCameraDefaultControls(getCameraControlSettings(stream));
          await applyCameraControls(stream, settings.cameraControls);
          setCameraCapabilities(getCameraCapabilities(stream));
        }
        setAdminStream(stream);
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = stream;
          await cameraPreviewRef.current.play();
        }
      } catch (error) {
        setMessage(error instanceof Error ? `Camera preview failed: ${error.message}` : 'Camera preview failed.');
      }
    };
    void start();
    return () => {
      active = false;
      controller.abort();
      stream?.getTracks().forEach((track) => track.stop());
      setAdminStream(null);
      setCameraCapabilities({});
      setCameraDefaultControls({});
      void window.photoBooth.setGuestCameraPaused(false);
    };
  }, [settings?.cameraId, settings?.cameraSource, tab]);


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

  const saveElevenLabs = async () => {
    try {
      const next = await window.photoBooth.updatePoseNarrationSettings({
        ...elevenLabs,
        ...(elevenLabsApiKey.trim() ? { apiKey: elevenLabsApiKey.trim() } : {})
      });
      setElevenLabs(next);
      setElevenLabsApiKey('');
      setMessage(next.configured ? 'ElevenLabs settings saved.' : 'Add an ElevenLabs API key.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const saveWorkflowShot = (index: number, partial: Partial<TemplateWorkflowSettings['shots'][number]>) => {
    const shots = settings.workflow.shots.map((shot, shotIndex) =>
      shotIndex === index ? { ...shot, ...partial } : shot
    );
    return saveMessage({ workflow: { ...settings.workflow, shots } }, `Photo ${index + 1} workflow saved.`);
  };

  const saveAudioSettings = async (audio: AppSettings['audio'], text = 'Audio saved.') => {
    const next = await saveMessage({ audio }, text);
    return next.audio;
  };

  const saveAudioCue = async (cue: AudioCue, text = 'Audio cue saved.') => {
    const textChanged = (settings.audio.cues[cue.id]?.text ?? '') !== cue.text;
    const nextAudio = await saveAudioSettings(
      {
        ...settings.audio,
        cues: {
          ...settings.audio.cues,
          [cue.id]: { ...cue, filePath: textChanged && cue.mode === 'host' ? '' : cue.filePath, updatedAt: new Date().toISOString() }
        }
      },
      text
    );
    if (textChanged && nextAudio.cues[cue.id]?.mode === 'host') setMessage('Text saved. Press Generate MP3 to create the new ElevenLabs voice file.');
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
    setMessage('Generating ElevenLabs MP3...');
    const result = await window.photoBooth.generateHostVoiceCue(cueId);
    await updateSettings(result.settings);
    if (!result.ok) {
      setMessage(result.error ?? 'ElevenLabs generation failed.');
      return;
    }
    setMessage('ElevenLabs MP3 generated.');
    if (playAfterGenerate) void playAudioCue(result.settings, cueId);
  };

  const generateAllHostVoiceCues = async () => {
    setMessage('Generating all ElevenLabs voice lines...');
    const result = await window.photoBooth.generateAllHostVoiceCues();
    await updateSettings(result.settings);
    setMessage(result.ok ? 'All ElevenLabs voice lines generated.' : result.error ?? 'ElevenLabs generation failed.');
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

  const importSlotMap = async (file?: File) => {
    if (!file) return;
    try {
      const raster = await loadRasterFromFile(file);
      const slots = detectPhotoSlots(raster);
      const name = file.name.replace(/\.png$/i, '').trim() || 'Template';
      const layout = normalizeTemplateLayoutForClient(layoutFromDetectedSlots(name, raster.width, raster.height, slots));
      const thumbnail = renderSlotMapThumbnail(layout);
      await saveTemplateLayout(layout);
      const next = await window.photoBooth.saveTemplateSlotPreview(layout.id, thumbnail);
      await updateSettings(next);
      setMessage(
        `Saved ${slots.length} photo slot${slots.length === 1 ? '' : 's'}. Background designs must be ${layout.paperWidth} × ${layout.paperHeight}.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read the template map.');
    } finally {
      if (slotMapInputRef.current) slotMapInputRef.current.value = '';
    }
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

  const uploadTemplateLayoutPreview = async (templateId: string) => {
    try {
      const next = await window.photoBooth.uploadTemplateLayoutPreview(templateId);
      await updateSettings(next);
      setMessage('Template guest preview uploaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Template guest preview upload failed.');
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
          ['poses', 'Poses', Camera],
          ['template', 'Template', Image],
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
          <h1>{adminTabLabel(tab)}</h1>
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
              <DraftInput value={settings.eventName} onSave={(value) => saveMessage({ eventName: value }, 'Event name saved.')} />
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
            <div className="admin-card audio-settings-panel">
              <div className="panel-title-row">
                <div><h2>ElevenLabs voice</h2><p>Global voice used by Workflow and every pose narration.</p></div>
                <strong>{elevenLabs.configured ? 'API ready' : 'API key needed'}</strong>
              </div>
              <div className="workflow-grid audio-global-grid">
                <label>API key<input type="password" value={elevenLabsApiKey} placeholder={elevenLabs.configured ? 'Saved — enter only to replace' : 'Paste ElevenLabs API key'} onChange={event => setElevenLabsApiKey(event.target.value)} /></label>
                <label>Voice ID<input value={elevenLabs.voiceId} onChange={event => setElevenLabs(value => ({ ...value, voiceId: event.target.value }))} /></label>
                <label>Model<select value={elevenLabs.modelId} onChange={event => setElevenLabs(value => ({ ...value, modelId: event.target.value as PoseNarrationSettings['modelId'] }))}><option value="eleven_v4_turbo">V4 Turbo</option><option value="eleven_flash_v2_5">Flash v2.5</option><option value="eleven_multilingual_v2">Multilingual v2</option><option value="eleven_v3">Eleven v3</option></select></label>
                <label>Speed<DraftInput type="number" min="0.7" max="1.2" step="0.05" value={elevenLabs.speed} onSave={value => setElevenLabs(current => ({ ...current, speed: Number(value) }))} /></label>
                <label>Stability<DraftInput type="number" min="0" max="1" step="0.05" value={elevenLabs.stability} onSave={value => setElevenLabs(current => ({ ...current, stability: Number(value) }))} /></label>
                <label>Similarity<DraftInput type="number" min="0" max="1" step="0.05" value={elevenLabs.similarityBoost} onSave={value => setElevenLabs(current => ({ ...current, similarityBoost: Number(value) }))} /></label>
                <label>Style<DraftInput type="number" min="0" max="1" step="0.05" value={elevenLabs.style} onSave={value => setElevenLabs(current => ({ ...current, style: Number(value) }))} /></label>
              </div>
              <label>Voice direction<input value={elevenLabs.direction} onChange={event => setElevenLabs(value => ({ ...value, direction: event.target.value }))} /></label>
              <div className="admin-actions"><button className="primary" onClick={() => void saveElevenLabs()}>Save ElevenLabs settings</button></div>
            </div>
            <label>
              Guest idle screen logo
              <div className="inline-field">
                <input value={settings.template.logoPath ? shortPath(settings.template.logoPath) : 'No logo uploaded'} readOnly />
                <button onClick={async () => {
                  const next = await window.photoBooth.uploadEventIdleLogo();
                  if (next) {
                    setMessage('Guest logo copied to the event folder.');
                  }
                }}>
                  <Image size={16} />Upload logo
                </button>
              </div>
            </label>
            <label>
              Admin password
              <DraftInput
                type="password"
                value={settings.adminPassword}
                placeholder="Optional for later"
                onSave={(value) => saveMessage({ adminPassword: value }, 'Password saved.')}
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
              <DraftInput
                value={settings.webApiBaseUrl}
                placeholder="http://localhost:3000"
                onSave={(value) => saveMessage({ webApiBaseUrl: value }, 'Web API URL saved.')}
              />
            </label>
            <label>
              Supabase URL
              <DraftInput
                value={settings.supabaseUrl}
                placeholder="https://your-project.supabase.co"
                onSave={(value) => saveMessage({ supabaseUrl: value }, 'Supabase URL saved.')}
              />
            </label>
            <label>
              Supabase publishable key
              <DraftInput
                value={settings.supabasePublishableKey}
                placeholder="sb_publishable_..."
                onSave={(value) => saveMessage({ supabasePublishableKey: value }, 'Supabase key saved.')}
              />
            </label>
            <label>
              Event ID
              <DraftInput
                value={settings.eventId}
                placeholder="Supabase event UUID"
                onSave={(value) => saveMessage({ eventId: value }, 'Event ID saved.')}
              />
            </label>
            <label>
              Booth secret
              <DraftInput
                type="password"
                value={settings.boothSecret}
                placeholder="Matches BOOTH_SHARED_SECRET"
                onSave={(value) => saveMessage({ boothSecret: value }, 'Booth secret saved.')}
              />
            </label>
            <div className="admin-card">
              <div className="panel-title-row">
                <div>
                  <h2>Cloud sync</h2>
                  <p>Saving an edit backs it up to the cloud. On another computer, press Sync now to download those changes. Camera, printer, folders, passwords, and API keys stay on each computer.</p>
                </div>
                <strong>{cloudSyncStatus.state === 'syncing' ? 'SYNCING' : cloudSyncStatus.state.toUpperCase()}</strong>
              </div>
              <p className="quiet">{cloudSyncStatus.message}</p>
              {cloudSyncStatus.lastSyncedAt && (
                <p className="quiet">Last synced {new Date(cloudSyncStatus.lastSyncedAt).toLocaleString()}</p>
              )}
              <div className="admin-actions">
                <button
                  disabled={cloudSyncStatus.state === 'syncing'}
                  onClick={async () => {
                    const status = await window.photoBooth.syncCloudNow();
                    setCloudSyncStatus(status);
                    setMessage(status.message);
                  }}
                >
                  <RefreshCw size={16} />Sync now
                </button>
              </div>
            </div>
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
                  Live video source
                  <select
                    value={settings.cameraSource}
                    onChange={(event) => {
                      const cameraSource = event.target.value === 'canon-usb' ? 'canon-usb' : 'capture-card';
                      void saveMessage(
                        { cameraSource, ...(cameraSource === 'canon-usb' ? { canonEnabled: true } : {}) },
                        cameraSource === 'canon-usb' ? 'Canon USB-C Live View selected.' : 'HDMI capture card selected.'
                      );
                    }}
                  >
                    <option value="canon-usb">Canon USB-C Live View</option>
                    <option value="capture-card">HDMI capture card</option>
                  </select>
                </label>
                {settings.cameraSource === 'capture-card' && (
                <label>
                  Capture card
                  <select value={settings.cameraId} onChange={(event) => void saveMessage({ cameraId: event.target.value }, 'Camera saved.')}>
                    <option value="">Default camera</option>
                    {cameras.map((camera) => (
                      <option key={camera.deviceId} value={camera.deviceId}>{camera.label || 'Camera'}</option>
                    ))}
                  </select>
                </label>
                )}
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.canonEnabled}
                    onChange={(event) => void saveMessage({ canonEnabled: event.target.checked }, 'Canon capture saved.')}
                  />
                  Take photos with the Canon camera
                </label>
                <p className="muted">
                  {settings.cameraSource === 'canon-usb'
                    ? 'Canon USB-C supplies the live mirror and recording. Full-resolution photos still use the Canon shutter and are cropped to this viewfinder.'
                    : 'The capture card supplies the live mirror and recording. Canon USB focuses and takes the full-resolution photo.'}
                </p>
                {settings.cameraSource === 'capture-card' && (
                <label>
                  Capture card framing
                  <select
                    value={settings.canonFraming === 'contain' ? 'contain' : 'cover'}
                    onChange={(event) =>
                      void saveMessage(
                        { canonFraming: event.target.value === 'contain' ? 'contain' : 'cover' },
                        'Capture card framing saved.'
                      )
                    }
                  >
                    <option value="cover">HDMI fills the frame</option>
                    <option value="contain">HDMI shows the whole photo with bars</option>
                  </select>
                </label>
                )}
                <div className="admin-actions">
                  <button
                    onClick={async () => {
                      setCanonStatus('Connecting to the Canon camera...');
                      const result = await window.photoBooth.canonConnect();
                      setCanonStatus(result.ok ? `Connected: ${result.model || 'Canon EOS'}` : result.error || 'Canon camera not found.');
                    }}
                  >
                    Connect Canon
                  </button>
                </div>
                {canonStatus && <p className="muted">{canonStatus}</p>}
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
                  <DraftInput
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.leftBleedIn}
                    onSave={(value) =>
                      saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            leftBleedIn: Number(value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Right crop
                  <DraftInput
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.rightBleedIn}
                    onSave={(value) =>
                      saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            rightBleedIn: Number(value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Top crop
                  <DraftInput
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.topBleedIn}
                    onSave={(value) =>
                      saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            topBleedIn: Number(value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Bottom crop
                  <DraftInput
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.bottomBleedIn}
                    onSave={(value) =>
                      saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            bottomBleedIn: Number(value)
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

        {tab === 'poses' && <AdminSection><Suspense fallback={<p>Loading pose editor…</p>}><PoseEditor settings={settings} /></Suspense></AdminSection>}
        {tab === 'workflow' && (
          <AdminSection>
            <div className="admin-card">
              <h2>Fun Pose Challenge</h2>
              <p>Guests choose Fun Pose Challenge or Normal Mode before photos. Fun mode uses matching pose guides; Normal Mode takes classic photos without a guide.</p>
              <label className="check-row"><input type="checkbox" checked={settings.poseGuide.selectionEnabled !== false} onChange={event => void saveMessage({ poseGuide: { ...settings.poseGuide, selectionEnabled: event.target.checked } }, 'Guest selection saved.')} />Ask who's joining before photos</label>
              <label>Maximum guests<DraftInput type="number" min="1" max="30" step="1" value={settings.poseGuide.groupCapacity ?? 12} onSave={value => void saveMessage({ poseGuide: { ...settings.poseGuide, groupCapacity: Number(value) } }, 'Group capacity saved.')} /></label>
              {settings.poseGuide.selectionEnabled === false && <div className="fixed-composition"><h3>Event guest group</h3><CompositionControls value={normalizePoseGuide(settings.poseGuide).defaultComposition!} capacity={normalizePoseGuide(settings.poseGuide).groupCapacity} onChange={value => void saveMessage({ poseGuide: { ...settings.poseGuide, defaultComposition: value } }, 'Event group saved.')} /></div>}
            </div>
            <div className="admin-card workflow-session-card">
              <div className="admin-card-header">
                <div>
                  <h2>Session flow</h2>
                  <p>Shared by every template and design.</p>
                </div>
              </div>
              <div className="workflow-grid workflow-session-grid">
              <label>
              Intro message
              <DraftInput
                value={settings.workflow.introMessage}
                onSave={(value) => saveMessage({ workflow: { ...settings.workflow, introMessage: value } }, 'Workflow saved.')}
              />
            </label>
            <label>
              Intro seconds
              <DraftInput
                type="number"
                min="0"
                step="0.5"
                value={msToSeconds(settings.workflow.introMs)}
                onSave={(value) =>
                  saveMessage(
                    { workflow: { ...settings.workflow, introMs: secondsToMs(value) } },
                    'Workflow saved.'
                  )
                }
              />
            </label>
            <label>
              Auto print seconds
              <DraftInput
                type="number"
                min="0"
                step="1"
                value={msToSeconds(settings.workflow.printAutoSelectMs)}
                onSave={(value) =>
                  saveMessage(
                    { workflow: { ...settings.workflow, printAutoSelectMs: secondsToMs(value) } },
                    'Workflow saved.'
                  )
                }
              />
            </label>
            <label>
              Thank you message
              <DraftInput
                value={settings.workflow.thankYouMessage}
                onSave={(value) => saveMessage({ workflow: { ...settings.workflow, thankYouMessage: value } }, 'Workflow saved.')}
              />
            </label>
            <label>
              Thank you seconds
              <DraftInput
                type="number"
                min="1"
                step="0.5"
                value={msToSeconds(settings.workflow.thankYouMs)}
                onSave={(value) => saveMessage({ workflow: { ...settings.workflow, thankYouMs: secondsToMs(value) } }, 'Workflow saved.')}
              />
            </label>
              </div>
            </div>

            {(() => {
              const shots = settings.workflow.shots;
              const shotIndex = Math.min(Math.max(selectedWorkflowShotIndex, 0), Math.max(shots.length - 1, 0));
              const shot = shots[shotIndex];
              if (!shot) return null;
              return (
                <div className="admin-card workflow-photo-card">
                  <div className="admin-card-header workflow-photo-header">
                    <div>
                      <h2>Photo messages and voices</h2>
                      <p>Game Mode and Normal Mode have separate messages and voices. Photo timing is shared across both modes.</p>
                    </div>
                    <label className="workflow-photo-picker">
                      Editing
                      <select
                        value={shotIndex}
                        onChange={(event) => setSelectedWorkflowShotIndex(Number(event.target.value))}
                      >
                        {shots.map((_item, index) => (
                          <option key={index} value={index}>{`Photo ${index + 1} of ${shots.length}`}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="workflow-photo-body">
                    <div className="workflow-photo-settings">
                      <div className="workflow-grid workflow-photo-timing-grid">
                        <label>
                          Camera before message
                          <DraftInput
                            type="number"
                            min="0"
                            step="0.5"
                            value={msToSeconds(shot.cameraBeforeMessageMs)}
                            onSave={(value) => saveWorkflowShot(shotIndex, { cameraBeforeMessageMs: secondsToMs(value) })}
                          />
                        </label>
                        <label>
                          Message time
                          <DraftInput
                            type="number"
                            min="0"
                            step="0.5"
                            value={msToSeconds(shot.messageMs)}
                            onSave={(value) => saveWorkflowShot(shotIndex, { messageMs: secondsToMs(value) })}
                          />
                        </label>
                        <label>
                          Camera before countdown
                          <DraftInput
                            type="number"
                            min="0"
                            step="0.5"
                            value={msToSeconds(shot.cameraBeforeCountdownMs)}
                            onSave={(value) => saveWorkflowShot(shotIndex, { cameraBeforeCountdownMs: secondsToMs(value) })}
                          />
                        </label>
                      </div>
                    </div>
                    <div className="workflow-photo-voice">
                      {(['fun', 'normal'] as const).map(mode => {
                        const cueId = mode === 'fun' ? `shot${shotIndex}` : `normalShot${shotIndex}`;
                        const cue = settings.audio.cues[cueId];
                        const label = mode === 'fun' ? 'Game Mode' : 'Normal Mode';
                        return <div className="workflow-mode-voice" key={mode}>
                          <h3>{label}</h3>
                          <label>Photo message
                            <DraftInput value={mode === 'fun' ? shot.message : shot.normalMessage ?? NORMAL_PHOTO_MESSAGE}
                              onSave={value => saveWorkflowShot(shotIndex, mode === 'fun' ? { message: value } : { normalMessage: value })} />
                            <small>Type {'\\n'} to start a new line.</small>
                          </label>
                          <AudioCueCard
                            cue={cue ? { ...cue, label: `${label} photo ${shotIndex + 1} voice` } : undefined}
                            settings={settings}
                            onSave={saveAudioCue}
                            onUpload={uploadAudioCue}
                            onRemove={removeAudioCue}
                            onGenerate={generateHostVoiceCue}
                            onTest={item => item.mode === 'host' && !item.filePath ? generateHostVoiceCue(item.id, true) : playAudioCue(settings, item.id)}
                          />
                        </div>;
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div className="admin-card audio-settings-panel">
              <div className="panel-title-row">
                <div>
                  <h2>Audio and volume</h2>
                  <p>Playback levels for generated voices, music, and effects. ElevenLabs is configured on the Event page.</p>
                </div>
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
                  ['welcomeRepeatSeconds', 'Welcome repeat seconds']
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <DraftInput
                      type="number"
                      min={key === 'welcomeRepeatSeconds' ? 3 : 0}
                      max={key === 'welcomeRepeatSeconds' ? 60 : 1}
                      step={key === 'welcomeRepeatSeconds' ? 1 : 0.05}
                      value={settings.audio[key as keyof AppSettings['audio']] as number}
                      onSave={(value) =>
                        saveAudioSettings({
                          ...settings.audio,
                          [key]: Number(value)
                        })
                      }
                    />
                  </label>
                ))}
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
                  Enable generated voice
                </label>
                <button onClick={() => void generateAllHostVoiceCues()}>Generate all MP3 files</button>
              </div>
              <p className="muted">
                Generation uses ElevenLabs and requires internet. Generated MP3 files are saved in the event folder and play offline during sessions.
              </p>
            </div>

            <div className="admin-card audio-cue-group">
              <div className="admin-card-header">
                <div>
                  <h2>Screen voice</h2>
                  <p>These voice cues are shared across every template.</p>
                </div>
              </div>
              <div className="audio-cue-grid">
                {['welcome', 'style', 'design', 'mode', 'people', 'intro', 'select', 'thanks'].map((cueId) => (
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

            <div className="admin-card audio-cue-group">
              <div className="admin-card-header">
                <div>
                  <h2>Countdown, music, and sound effects</h2>
                  <p>Shared countdown voice, interface sounds, shutter, and background music.</p>
                </div>
              </div>
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
                    <button onClick={() => slotMapInputRef.current?.click()}>Create template from map</button>
                    <button onClick={() => void importTemplate()}>Import Template</button>
                    <input
                      ref={slotMapInputRef}
                      type="file"
                      accept="image/png,.png"
                      hidden
                      onChange={(event) => void importSlotMap(event.target.files?.[0])}
                    />
                  </div>
                  <p className="muted">
                    Upload a PNG map: solid black rectangles on white, with white gaps between them. No outlines, text, or artwork.
                    Slots are saved on a {templateDimensions('portrait').width} × {templateDimensions('portrait').height} portrait canvas, or {templateDimensions('landscape').width} × {templateDimensions('landscape').height} for a wide map. Each background design must use that same size.
                  </p>
                  <div className="custom-template-layout">
                    <div className="template-list-panel">
                      {(() => {
                        const activeLayouts = layouts.filter((layout) => layout.active);
                        const inactiveLayouts = layouts.filter((layout) => !layout.active);
                        const renderTemplateListItem = (layout: TemplateLayout) => (
                          <button
                            key={layout.id}
                            type="button"
                            className={selectedLayout?.id === layout.id ? 'active template-list-item' : 'template-list-item'}
                            onClick={() => {
                              setSelectedAdminTemplateId(layout.id);
                              setTemplateListGroupsOpen((current) => ({
                                active: layout.active ? true : current.active,
                                inactive: layout.active ? current.inactive : true
                              }));
                            }}
                          >
                            <span>{layout.name}</span>
                            <small>
                              {layout.photoWindows.length} photo{layout.photoWindows.length === 1 ? '' : 's'}
                            </small>
                          </button>
                        );
                        const renderGroup = (
                          key: 'active' | 'inactive',
                          label: string,
                          items: TemplateLayout[]
                        ) => {
                          const isOpen = templateListGroupsOpen[key];
                          return (
                            <div className={`template-list-group${isOpen ? ' open' : ''}`}>
                              <button
                                type="button"
                                className="template-list-group-heading"
                                onClick={() =>
                                  setTemplateListGroupsOpen((current) => ({
                                    ...current,
                                    [key]: !current[key]
                                  }))
                                }
                              >
                                <span>{label}</span>
                                <span>{items.length}</span>
                              </button>
                              {isOpen && (
                                <div className="template-list-group-body">
                                  {items.map(renderTemplateListItem)}
                                  {items.length === 0 && <p className="muted">No {label.toLowerCase()} templates.</p>}
                                </div>
                              )}
                            </div>
                          );
                        };
                        return (
                          <>
                            {renderGroup('active', 'Active', activeLayouts)}
                            {renderGroup('inactive', 'Inactive', inactiveLayouts)}
                          </>
                        );
                      })()}
                      {layouts.length === 0 && <p className="muted">Create or import a template to begin.</p>}
                    </div>
                    {selectedLayout && (
                      <div className="template-detail-panel">
                        <div className="template-style-summary">
                          <TemplateMini layout={selectedLayout} />
                          <div>
                            <h2>{selectedLayout.name}</h2>
                            <p>{selectedLayout.photoWindows.length} photos / {selectedLayout.orientation}</p>
                            <p>Background designs must be {selectedLayout.paperWidth} × {selectedLayout.paperHeight}.</p>
                            <label className="check-row">
                              <input
                                type="checkbox"
                                checked={selectedLayout.active}
                                onChange={(event) => {
                                  const nextActive = event.target.checked;
                                  setTemplateListGroupsOpen((current) => ({
                                    active: nextActive ? true : current.active,
                                    inactive: nextActive ? current.inactive : true
                                  }));
                                  void saveTemplateLayout({ ...selectedLayout, active: nextActive });
                                }}
                              />
                              Active (show in guest template chooser)
                            </label>
                            <div className="template-guest-preview-admin">
                              <h3>Guest chooser preview</h3>
                              <div className="template-guest-preview-admin-row">
                                {selectedLayout.guestPreviewPath ? (
                                  <ImagePathThumb path={selectedLayout.guestPreviewPath} label={selectedLayout.name} />
                                ) : (
                                  <p className="muted">Optional. Upload an image for the guest template choosing screen.</p>
                                )}
                                <button onClick={() => void uploadTemplateLayoutPreview(selectedLayout.id)}>
                                  Upload guest preview
                                </button>
                              </div>
                            </div>
                            {(() => {
                              const slotCount = selectedLayout.photoWindows.length;
                              const photosToTake = normalizePhotosToTake(selectedLayout.photosToTake, slotCount);
                              return (
                                <label className="template-photos-to-take">
                                  <span>Photos to take</span>
                                  <DraftInput
                                    type="number"
                                    min={slotCount}
                                    max={MAX_PHOTOS_TO_TAKE}
                                    value={photosToTake}
                                    onSave={(value) => {
                                      const next = normalizePhotosToTake(Number(value), slotCount);
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
                              <button onClick={() => void uploadTemplate(selectedLayout.id)}>Add background design</button>
                              <button onClick={() => void exportTemplate(selectedLayout.id)}>Export JSON</button>
                              <button className="danger" onClick={() => void deleteTemplateLayout(selectedLayout.id)}>Delete template</button>
                            </div>
                          </div>
                        </div>
                        <div className="template-design-grid">
                          {selectedDesigns.map((design) => (
                            <TemplateDesignAdminCard
                              key={design.id}
                              design={design}
                              settings={settings}
                              onSave={saveTemplateDesign}
                              onUpdateAsset={updateTemplateAsset}
                              onDelete={deleteTemplateDesign}
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
                  <DraftInput
                    value={settings.ai.providers[settings.ai.provider].model}
                    onSave={(value) => updateAiProvider(settings.ai.provider, { model: value })}
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
                <DraftInput
                  type="password"
                  value={settings.ai.providers[settings.ai.provider].apiKey}
                  onSave={(value) => updateAiProvider(settings.ai.provider, { apiKey: value })}
                />
              </label>
              <label>
                API URL
                <DraftInput
                  value={settings.ai.providers[settings.ai.provider].apiUrl}
                  onSave={(value) => updateAiProvider(settings.ai.provider, { apiUrl: value })}
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
                    <DraftInput value={preset.name} onSave={(value) => saveAiPreset({ ...preset, name: value })} />
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
        <div className="audio-cue-preview-actions">
          <button type="button" onClick={() => onTest(cue)}>Play</button>
          <button type="button" onClick={() => stopAudioCue(cue.id)} disabled={!cue.filePath}>Stop</button>
        </div>
      </div>
      <div className="audio-cue-controls">
        <label>
          Mode
          <select value={cue.mode} onChange={(event) => void onSave({ ...cue, mode: event.target.value as AudioCue['mode'] })}>
            <option value="off">Off</option>
            <option value="mp3">MP3</option>
            {cue.channel === 'voice' && <option value="host">ElevenLabs voice</option>}
          </select>
        </label>
        <label>
          Volume
          <DraftInput
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={cue.volume}
            onSave={(value) => onSave({ ...cue, volume: Number(value) })}
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
          <DraftInput value={cue.text} onSave={(value) => onSave({ ...cue, text: value })} />
        </label>
      )}
      <div className="audio-file-row">
        <button type="button" onClick={() => void onUpload(cue.id)}>Upload MP3</button>
        {cue.channel === 'voice' && <button type="button" onClick={() => void onGenerate(cue.id)}>Generate MP3</button>}
        <button type="button" onClick={() => void onRemove(cue.id)} disabled={!cue.filePath}>Clear</button>
        <span title={cue.filePath}>{fileName || (cue.mode === 'mp3' ? 'No file' : settings.audio.enabled ? 'No file' : 'Audio off')}</span>
      </div>
    </div>
  );
}

function AdminSection({ children }: { children: React.ReactNode }) {
  return <div className="admin-section">{children}</div>;
}

function DraftInput({
  value,
  onSave,
  onFocus,
  onBlur,
  ...rest
}: {
  value: string | number;
  onSave: (value: string) => void | Promise<unknown>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'>) {
  const valueText = String(value);
  const [draft, setDraft] = useState(valueText);
  const [isFocused, setIsFocused] = useState(false);
  const numeric = rest.type === 'number';

  useEffect(() => {
    if (!isFocused) setDraft(valueText);
  }, [isFocused, valueText]);

  const commit = () => {
    if (!numeric) {
      if (draft !== valueText) void onSave(draft);
      return;
    }
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(valueText);
      return;
    }
    const min = rest.min === undefined ? parsed : Number(rest.min);
    const max = rest.max === undefined ? parsed : Number(rest.max);
    const next = Math.min(max, Math.max(min, parsed));
    if (next !== Number(valueText)) void onSave(String(next));
    else setDraft(String(next));
  };

  return (
    <input
      {...rest}
      type={numeric ? 'text' : rest.type}
      inputMode={numeric ? 'decimal' : rest.inputMode}
      value={draft}
      onFocus={(event) => {
        setIsFocused(true);
        onFocus?.(event);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        setIsFocused(false);
        onBlur?.(event);
        commit();
      }}
      onKeyDown={(event) => {
        rest.onKeyDown?.(event);
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
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
          <DraftInput
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onSave={(next) => onChange(key, Number(next))}
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
// (1200x1800 at 300 dpi) with headroom, while keeping PNG encode time and
// memory usage reasonable on kiosk hardware.
const CAPTURE_NATIVE_MAX_LONG_EDGE = 3600;

const captureFrameGeometry = (
  video: HTMLVideoElement,
  settings: AppSettings,
  viewportWidth: number,
  viewportHeight: number
) => {
  const rotation = settings.cameraRotation;
  const sideways = rotation === 90 || rotation === 270;
  const visualWidth = sideways ? video.videoHeight : video.videoWidth;
  const visualHeight = sideways ? video.videoWidth : video.videoHeight;
  const baseCoverScale = Math.max(viewportWidth / visualWidth, viewportHeight / visualHeight);
  let outputScale = baseCoverScale > 0 && Number.isFinite(baseCoverScale) ? 1 / baseCoverScale : 1;
  outputScale = Math.max(0.1, outputScale);
  let width = Math.round(viewportWidth * outputScale);
  let height = Math.round(viewportHeight * outputScale);
  const longEdge = Math.max(width, height);
  if (longEdge > CAPTURE_NATIVE_MAX_LONG_EDGE) {
    const clamp = CAPTURE_NATIVE_MAX_LONG_EDGE / longEdge;
    width = Math.max(1, Math.round(width * clamp));
    height = Math.max(1, Math.round(height * clamp));
    outputScale *= clamp;
  }
  return { width, height, outputScale };
};

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

  const { width: targetWidth, height: targetHeight, outputScale } = captureFrameGeometry(
    video,
    settings,
    viewportWidth,
    viewportHeight
  );
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
  const line2 = 'Scan to Download';
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

const adminTabLabel = (tab: string) => ({
  event: 'Event',
  camera: 'Camera',
  printer: 'Printer',
  workflow: 'Workflow',
  template: 'Template',
  aiPresets: 'AI presets',
  aiQueue: 'AI queue',
  gallery: 'Gallery'
} as Record<string, string>)[tab] ?? tab;

const photoNumber = (name: string) => name.replace(/\.[^.]+$/, '');

const displayedPhotoNumber = (savedName: string, session: BoothSession | null | undefined) =>
  session?.ticket.queue_number != null ? String(session.ticket.queue_number) : photoNumber(savedName);

const templatePreviewPath = (design: TemplateDesign) => design.previewPath || design.filePath || design.framePath;

const templateFramePath = (design: TemplateDesign) => design.framePath || design.filePath || design.previewPath;

const shortPath = (filePath: string) => filePath.split(/[\\/]/).slice(-2).join('/');

const printerForTemplate = (settings: AppSettings, layout: TemplateLayout) =>
  layout.printerName || settings.defaultPrinter;

const workflowForTemplate = (settings: AppSettings, layout: TemplateLayout, mode: SessionMode = 'fun'): TemplateWorkflowSettings => {
  const shotCount = normalizePhotosToTake(layout.photosToTake, layout.photoWindows.length);
  return {
    introMessage: settings.workflow.introMessage,
    introMs: settings.workflow.introMs,
    printAutoSelectMs: settings.workflow.printAutoSelectMs,
    thankYouMessage: settings.workflow.thankYouMessage,
    thankYouMs: settings.workflow.thankYouMs,
    screenCues: {
      intro: settings.audio.cues.intro,
      select: settings.audio.cues.select,
      thanks: settings.audio.cues.thanks
    },
    shots: Array.from({ length: shotCount }, (_item, index) => {
      const shot = settings.workflow.shots[index] ?? settings.workflow.shots[settings.workflow.shots.length - 1];
      return photoForMode(shot, settings.audio.cues, Math.min(index, settings.workflow.shots.length - 1), mode);
    })
  };
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
  const { width, height } = slotGeometry(slot);
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
