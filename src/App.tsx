import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';
import { ArrowUp, Camera, Copy, Download, Expand, ExternalLink, FolderOpen, Globe, Image, Minimize2, Printer, RefreshCw, RotateCw, Settings, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { AiPreset, AiProvider, AiQueueItem, AppSettings, AudioCue, BoothSession, CameraControlSettings, CameraRotation, Capture, FaceAsset, FaceAssetPack, FaceAssetPlacement, Gallery, GalleryUploadStatus, QueueSnapshot, SavedPhoto, TemplateDesign, TemplateLayout, TemplateSlot, TemplateWorkflowSettings } from './types';
import { createBlankTemplateLayout, createGuideTemplateImage, createTemplatedPrintImage, defaultTemplateScreenCue, defaultTemplateShotAudioCue, getPrimarySlot, normalizeTemplateLayoutForClient, normalizeTemplateWorkflow, templateDimensions } from './template';
import { FaceAssetStabilizer, FaceTracker, clearFaceAssetCanvas, detectFaces, drawFaceAssets, drawFaceDebugInfo, selectedFaceAssetPack } from './faceAssets';
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

type GuestStep = 'queue' | 'welcome' | 'style' | 'design' | 'intro' | 'capture' | 'select' | 'thanks';

const buttonText = (value: string) => `[ ${value} ]`;
const PHONE_MAX_DIGITS = 15;

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
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedDesignId, setSelectedDesignId] = useState('');
  const [thankYouCountdown, setThankYouCountdown] = useState<number | null>(null);
  const [printedPreview, setPrintedPreview] = useState('');
  const [printedNumber, setPrintedNumber] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFaceDebug, setShowFaceDebug] = useState(true);
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
  const pendingVideoSaveRef = useRef<Promise<string | null> | null>(null);
  const pendingVideoPathRef = useRef<string | null>(null);
  const pendingVideoTicketIdRef = useRef<string | null>(null);
  const isUploadingSessionVideoRef = useRef(false);
  const pendingGalleryUploadRef = useRef<{ settings: AppSettings; session: BoothSession | null; finalPath: string } | null>(null);
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
    if (step === 'select') void playAudioCueObject(settings, workflow?.screenCues?.select);
    if (step === 'thanks') void playAudioCueObject(settings, workflow?.screenCues?.thanks, workflow?.thankYouMessage);
  }, [settings, settings?.audio, step, selectedTemplateId, selectedDesignId]);

  useEffect(() => {
    if (step !== 'thanks' || !phoneSubmitted) {
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
  }, [phoneSubmitted, selectedWorkflow?.thankYouMs, settings?.workflow.thankYouMs, step]);

  useEffect(() => {
    if (step !== 'thanks' || thankYouCountdown !== 0) return;
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setPrintedPreview('');
    setPrintedNumber('');
    setIsAiGenerating(false);
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
    setThankYouCountdown(null);
    setStep(queueModeEnabled ? 'queue' : 'welcome');
  }, [queueModeEnabled, step, thankYouCountdown]);

  const resetGuestSession = () => {
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setPrintedPreview('');
    setPrintedNumber('');
    setIsAiGenerating(false);
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

  const startCamera = async () => {
    if (!settings) throw new Error('Settings not ready.');
    stopCamera();
    const videoSettings: MediaTrackConstraints = {
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
    await waitFor(() => videoRef.current);
    if (!videoRef.current) throw new Error('Camera view not ready.');
    videoRef.current.srcObject = stream;
    await videoRef.current.play();
  };

  useEffect(() => {
    if (!settings || step !== 'welcome') return undefined;
    let active = true;
    void startCamera().catch((error) => {
      if (active) console.warn('Welcome camera preview unavailable.', error);
    });
    return () => {
      active = false;
      stopCamera();
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
  };

  // Captures the full on-screen composite (camera + face-asset overlays +
  // countdown/messages) of the booth window plus microphone audio, mirroring the
  // way stills are screenshotted, so the saved video matches what the guest sees.
  const startSessionRecording = async () => {
    if (mediaRecorderRef.current || typeof MediaRecorder === 'undefined') return;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 10, max: 10 },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 }
        },
        audio: false
      });
      const tracks = [...displayStream.getVideoTracks()];
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
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
        videoBitsPerSecond: 1_800_000,
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

    // Take an actual screenshot of the live window (video + face assets exactly
    // as composited on screen). No programmatic re-rendering or re-detection,
    // so the photo matches the preview 1:1.
    setIsCapturing(true);
    await nextPaint();

    try {
      let rect: { x: number; y: number; width: number; height: number } | undefined;
      if (!useFullLiveView && captureGuideRef.current) {
        const bounds = captureGuideRef.current.getBoundingClientRect();
        rect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
      }
      const screenshot = await window.photoBooth.capturePage(rect);
      // Cover-crop the screenshot to the slot's exact aspect ratio so it drops
      // into the print frame without stretching, for every template style.
      const dataUrl = await coverCropToAspect(screenshot, slot.width / slot.height, slot.cropY);
      setIsFlashing(true);
      window.setTimeout(() => setIsFlashing(false), 180);
      const saved = await window.photoBooth.saveImage({ dataUrl, kind: 'original', filenamePrefix: 'original' });
      return { dataUrl, ...saved };
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

  const activeFacePack = settings && selectedDesign ? selectedFaceAssetPack(settings, selectedDesign) : null;

  useEffect(() => {
    const canvas = faceOverlayCanvasRef.current;
    if (!settings || !canvas || step !== 'capture' || !activeFacePack) {
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
            if (showFaceDebug) drawFaceDebugInfo(ctx, displayResult, overlay.width, overlay.height);
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
  }, [activeFacePack, settings?.cameraRotation, settings?.mirrorPreview, showFaceDebug, step]);

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
    setStep('intro');
    void startSession(design.templateId, design);
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
    setPrintedPreview('');
    setPrintedNumber('');
    setIsAiGenerating(false);
    setCaptureMessage('');
    setCountdown(null);

    try {
      setStep('intro');
      await delay(workflow.introMs);
      if (sessionRunRef.current !== runId) return;
      setStep('capture');
      await delay(100);
      await startCamera();
      if (design?.videoRecordingEnabled) {
        await startSessionRecording();
      }

      const shotPlan = layout.photoWindows.map((_item, index) => workflow.shots[index % workflow.shots.length]);
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
        const capture = await captureFrame(
          getPrimarySlot(layout, nextCaptures.length),
          false
        );
        void playAudioCue(settings, 'shutter');
        nextCaptures.push(capture);
        setCaptures([...nextCaptures]);
        await delay(350);
      }

      stopSessionRecording();
      stopCamera();
      const defaultIndexes = Array.from({ length: layout.photoWindows.length }, (_item, index) => index).filter((index) => index < nextCaptures.length);
      setSelectedCaptureIndexes(defaultIndexes);
      if (design) {
        await printCaptures(nextCaptures, defaultIndexes, layout.id, design);
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
    design: TemplateDesign
  ) => {
    if (!settings) return;
    const layout = templateLayouts.find((item) => item.id === templateId);
    if (!layout) return;
    const photoDataUrls = indexes
      .slice(0, layout.photoWindows.length)
      .map((index) => sourceCaptures[index]?.dataUrl)
      .filter(Boolean) as string[];
    if (photoDataUrls.length < layout.photoWindows.length) return;
    setIsBusy(true);
    stopAudioChannel('voice');
    setPrintedPreview('');
    setPrintedNumber('');
    setUploadMessage('');
    setPhoneNumber('');
    setPhoneSubmitted(false);
    setPhoneEntryMessage('');
    pendingGalleryUploadRef.current = null;
    setIsAiGenerating(design.usesAi);
    setStep('thanks');

    const printFinal = async () => {
      const templateDataUrl = await window.photoBooth.getImageDataUrl(templateFramePath(design));
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

      let dataUrl = await createTemplatedPrintImage(photoDataUrls, layout, design, templateDataUrl);
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
        }
        setIsAiGenerating(false);
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
    };

    try {
      await printFinal();
    } finally {
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

  const finishPhoneEntry = (options: { phoneNumber?: string; marketingConsentValue?: boolean }) => {
    setPhoneEntryMessage('');
    setPhoneSubmitted(true);
    const pending = pendingGalleryUploadRef.current;
    pendingGalleryUploadRef.current = null;
    if (!pending) return;
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
    <GuestShell flash={isFlashing} compactTop={step === 'queue'} thanksLayout={step === 'thanks'}>
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
          {activeFacePack && !isCapturing && (
            <KioskButton className="face-debug-toggle" onPress={() => setShowFaceDebug((current) => !current)}>
              {showFaceDebug ? 'Hide debug' : 'Show debug'}
            </KioskButton>
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

      {step === 'thanks' && (
        <section className="thanks-screen">
          <div className="thanks-top-actions">
            <KioskButton
              className="thanks-restart-button"
              onPress={() => {
                void playAudioCue(settings, 'button');
                resetGuestSession();
              }}
            >
              Restart
            </KioskButton>
          </div>
          {(printedPreview || isAiGenerating) && (
            <div className={`thanks-preview ${isAiGenerating ? 'generating' : ''}`}>
              {printedNumber && <p className="thanks-photo-number">Photo# {printedNumber}</p>}
              {printedPreview && <img src={printedPreview} alt="Printed layout preview" />}
              {isAiGenerating && <span>GENERATING</span>}
            </div>
          )}
          <div className="thanks-content">
            {!phoneSubmitted ? (
              <>
                <p className="thanks-copy">Enter your phone # to view / download your photo at <span className="thanks-site">vibobooth.com</span>.</p>
                <div className="phone-entry-display">{formatPhoneNumber(phoneNumber) || 'Phone number'}</div>
                <DigitKeypad
                  className="phone-keypad"
                  disabled={isBusy || isAiGenerating}
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
                      disabled={isBusy || isAiGenerating}
                    />
                    <span>I agree to use phone number to access my photo gallery</span>
                  </label>
                  <label className="phone-consent-row">
                    <input
                      type="checkbox"
                      checked={marketingConsent}
                      onChange={(event) => {
                        setMarketingConsent(event.target.checked);
                        setPhoneEntryMessage('');
                      }}
                      disabled={isBusy || isAiGenerating}
                    />
                    <span>I agree to receive promotional texts from Stephanie Wong. I can unsubscribe anytime.</span>
                  </label>
                </div>
                <div className="phone-action-row">
                  <KioskButton
                    className="booth-button"
                    onPress={submitPhoneNumber}
                    disabled={
                      isBusy ||
                      isAiGenerating ||
                      phoneNumber.replace(/\D/g, '').length < 7 ||
                      (!galleryConsent && !marketingConsent)
                    }
                  >
                    Submit
                  </KioskButton>
                  <KioskButton
                    className="booth-button"
                    onPress={skipPhoneEntry}
                    disabled={isBusy || isAiGenerating}
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
                  {galleryQrDataUrl
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
          checked={design.faceTrackingEnabled}
          onChange={(event) => void onSave({ ...design, faceTrackingEnabled: event.target.checked })}
        />
        Face assets
      </label>
      {design.faceTrackingEnabled && (
        <label>
          Asset pack
          <select
            value={design.faceAssetPackId}
            onChange={(event) => void onSave({ ...design, faceAssetPackId: event.target.value })}
          >
            <option value="">Choose asset pack</option>
            {settings.template.faceAssetPacks
              .filter((pack) => pack.active)
              .map((pack) => (
                <option key={pack.id} value={pack.id}>{pack.name}</option>
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
          shotCount={layout.photoWindows.length}
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
  const screenCue = (cueId: 'intro' | 'select' | 'thanks') => {
    const defaults = {
      intro: defaultTemplateScreenCue(cueScopeId, 'intro', 'Intro screen voice', normalized.introMessage),
      select: defaultTemplateScreenCue(cueScopeId, 'select', 'Photo selection voice', 'Please choose your favorite pictures to print.'),
      thanks: defaultTemplateScreenCue(cueScopeId, 'thanks', 'Finish screen voice', normalized.thankYouMessage)
    };
    return {
      ...defaults[cueId],
      ...(normalized.screenCues?.[cueId] ?? {}),
      id: normalized.screenCues?.[cueId]?.id || `${cueScopeId}-${cueId}`,
      channel: 'voice' as const
    };
  };
  const saveScreenCue = async (cueId: 'intro' | 'select' | 'thanks', cue: AudioCue) => {
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
          {(['intro', 'select', 'thanks'] as const).map((cueId) => {
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
  const { settings, updateSettings } = useSettings();
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
                  await window.photoBooth.openGuest();
                  setMessage('Guest window opened.');
                }}
              >
                Open guest window
              </button>
              <button
                onClick={async () => {
                  await window.photoBooth.openGuestPickerPreview();
                  setMessage('Guest photo picker opened.');
                }}
              >
                Open photo picker
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
                          shotCount={selectedLayout.photoWindows.length}
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

const loadDataUrlImage = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image for upload.'));
    image.src = dataUrl;
  });

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
  const margin = Math.round(qrSize * 0.28);
  const x = canvas.width - qrSize - margin;
  const y = canvas.height - qrSize - margin;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 8, y - 8, qrSize + 16, qrSize + 16);
  ctx.drawImage(qrImage, x, y, qrSize, qrSize);

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

const workflowForDesign = (layout: TemplateLayout, design: TemplateDesign | null): TemplateWorkflowSettings =>
  design?.workflowOverrideEnabled && design.workflowOverride
    ? normalizeTemplateWorkflow(design.workflowOverride, layout.photoWindows.length)
    : normalizeTemplateWorkflow(layout.workflowDefaults, layout.photoWindows.length);

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
