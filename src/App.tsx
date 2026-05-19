import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Camera, Download, Expand, ExternalLink, FolderOpen, Image, Minimize2, Printer, RefreshCw, Settings, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { AiPreset, AiProvider, AiQueueItem, AppSettings, CameraControlSettings, CameraRotation, Capture, Gallery, SavedPhoto, TemplateDesign, TemplateSlot, TemplateStyleId } from './types';
import { createGuideTemplateImage, createTemplatedPrintImage, getPrimarySlot, getTemplateStyle, PRINT_HEIGHT, PRINT_WIDTH, TEMPLATE_HEIGHT, TEMPLATE_STYLES, TEMPLATE_WIDTH } from './template';

type GuestStep = 'welcome' | 'style' | 'design' | 'intro' | 'capture' | 'select' | 'thanks';

const buttonText = (value: string) => `[ ${value} ]`;

function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    void window.photoBooth.getSettings().then(setSettings);
  }, []);

  const updateSettings = async (partial: Partial<AppSettings>) => {
    const next = await window.photoBooth.updateSettings(partial);
    setSettings(next);
    return next;
  };

  return { settings, updateSettings };
}

export function App() {
  const query = new URLSearchParams(window.location.search);
  const windowKind = query.get('window') === 'admin' ? 'admin' : 'guest';
  return windowKind === 'admin' ? <AdminApp /> : <GuestApp />;
}

function GuestApp() {
  const query = new URLSearchParams(window.location.search);
  const shouldOpenPickerPreview = query.get('preview') === 'picker';
  const { settings } = useSettings();
  const [step, setStep] = useState<GuestStep>('welcome');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [captureMessage, setCaptureMessage] = useState('');
  const [error, setError] = useState('');
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedCaptureIndexes, setSelectedCaptureIndexes] = useState<number[]>([]);
  const [selectedStyleId, setSelectedStyleId] = useState<TemplateStyleId>('style1');
  const [selectedDesignId, setSelectedDesignId] = useState('');
  const [printCountdown, setPrintCountdown] = useState<number | null>(null);
  const [thankYouCountdown, setThankYouCountdown] = useState<number | null>(null);
  const [printedPreview, setPrintedPreview] = useState('');
  const [printedNumber, setPrintedNumber] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastShortcutRef = useRef('');
  const sessionRunRef = useRef(0);

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
    if (step !== 'thanks') {
      setThankYouCountdown(null);
      return undefined;
    }
    const totalSeconds = Math.ceil((settings?.workflow.thankYouMs ?? 3000) / 1000);
    setThankYouCountdown(totalSeconds);
    const countdownTimer = window.setInterval(() => {
      setThankYouCountdown((current) => (current === null ? current : Math.max(0, current - 1)));
    }, 1000);
    const timer = window.setTimeout(() => {
      setCaptures([]);
      setSelectedCaptureIndexes([]);
      setPrintedPreview('');
      setPrintedNumber('');
      setIsAiGenerating(false);
      setCountdown(null);
      setCaptureMessage('');
      setError('');
      setStep('welcome');
    }, settings?.workflow.thankYouMs ?? 3000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(countdownTimer);
    };
  }, [settings, step]);

  const resetGuestSession = () => {
    setCaptures([]);
    setSelectedCaptureIndexes([]);
    setPrintedPreview('');
    setPrintedNumber('');
    setIsAiGenerating(false);
    setCountdown(null);
    setCaptureMessage('');
    setError('');
    setStep('welcome');
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
    const firstActive = settings.template.designs.find((design) => design.active);
    setSelectedStyleId(firstActive?.styleId ?? settings.template.selectedStyleId ?? 'style1');
    setSelectedDesignId(firstActive?.id ?? settings.template.selectedDesignId ?? '');
  }, [settings?.template.designs, settings?.template.selectedStyleId, settings?.template.selectedDesignId]);

  useEffect(() => {
    const releaseCamera = () => {
      sessionRunRef.current += 1;
      stopCamera();
    };
    window.addEventListener('beforeunload', releaseCamera);
    window.addEventListener('pagehide', releaseCamera);
    return () => {
      window.removeEventListener('beforeunload', releaseCamera);
      window.removeEventListener('pagehide', releaseCamera);
      releaseCamera();
    };
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
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
    await applyCameraControls(stream, settings.cameraControls);
    streamRef.current = stream;
    await waitFor(() => videoRef.current);
    if (!videoRef.current) throw new Error('Camera view not ready.');
    videoRef.current.srcObject = stream;
    await videoRef.current.play();
  };

  const captureFrame = async (slot: TemplateSlot, useFullLiveView = false) => {
    if (!videoRef.current || !settings) throw new Error('Camera not ready.');
    const video = videoRef.current;
    const rotation = settings.cameraRotation;
    const sourceWidth = video.videoWidth || 3840;
    const sourceHeight = video.videoHeight || 2160;
    const isSideways = rotation === 90 || rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = isSideways ? sourceHeight : sourceWidth;
    canvas.height = isSideways ? sourceWidth : sourceHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not ready.');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    if (settings.mirrorPreview) {
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    const dataUrl = useFullLiveView ? canvas.toDataURL('image/png') : cropCanvasToSlot(canvas, slot);
    setIsFlashing(true);
    window.setTimeout(() => setIsFlashing(false), 180);
    const saved = await window.photoBooth.saveImage({ dataUrl, kind: 'original', filenamePrefix: 'original' });
    return { dataUrl, ...saved };
  };

  const runCountdown = async (runId: number) => {
    for (const value of [3, 2, 1]) {
      if (sessionRunRef.current !== runId) return false;
      setCountdown(value);
      await delay(1000);
    }
    setCountdown(null);
    return true;
  };

  const activeDesigns = settings?.template.designs.filter((design) => design.active) ?? [];
  const selectedStyle = getTemplateStyle(selectedStyleId);
  const selectedDesign = activeDesigns.find((design) => design.id === selectedDesignId) ?? null;
  const selectedPhotoDataUrls = selectedCaptureIndexes
    .slice(0, selectedStyle.selectCount)
    .map((index) => captures[index]?.dataUrl)
    .filter(Boolean) as string[];

  const chooseStyle = (styleId: TemplateStyleId) => {
    const firstDesign = activeDesigns.find((design) => design.styleId === styleId);
    setSelectedStyleId(styleId);
    setSelectedDesignId(firstDesign?.id ?? '');
    setSelectedCaptureIndexes([]);
    setStep(firstDesign ? 'design' : 'style');
  };

  const chooseDesign = (design: TemplateDesign) => {
    setSelectedStyleId(design.styleId);
    setSelectedDesignId(design.id);
    setStep('intro');
    void startSession(design.styleId, design);
  };

  const startSession = async (styleId = selectedStyleId, design = selectedDesign) => {
    if (!settings || isBusy) return;
    const style = getTemplateStyle(styleId);
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
      await delay(settings.workflow.introMs);
      if (sessionRunRef.current !== runId) return;
      setStep('capture');
      await delay(100);
      await startCamera();

      const shotPlan = Array.from({ length: style.shotCount }, (_item, index) => settings.workflow.shots[index % settings.workflow.shots.length]);
      const nextCaptures: Capture[] = [];

      for (const shot of shotPlan) {
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage('');
        await delay(shot.cameraBeforeMessageMs);
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage(shot.message);
        await delay(shot.messageMs);
        if (sessionRunRef.current !== runId) return;
        setCaptureMessage('');
        await delay(shot.cameraBeforeCountdownMs);
        if (!(await runCountdown(runId))) return;
        const capture = await captureFrame(getPrimarySlot(style.id, nextCaptures.length), liveViewUsesFullScreen(style.id));
        nextCaptures.push(capture);
        setCaptures([...nextCaptures]);
        await delay(350);
      }

      stopCamera();
      const defaultIndexes = Array.from({ length: style.selectCount }, (_item, index) => index).filter((index) => index < nextCaptures.length);
      setSelectedCaptureIndexes(defaultIndexes);
      if (styleNeedsSelection(style.id)) {
        setStep('select');
      } else if (design) {
        await printCaptures(nextCaptures, defaultIndexes, style.id, design);
      } else {
        setStep('select');
      }
    } catch {
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
    styleId: TemplateStyleId,
    design: TemplateDesign
  ) => {
    if (!settings) return;
    const style = getTemplateStyle(styleId);
    const photoDataUrls = indexes
      .slice(0, style.selectCount)
      .map((index) => sourceCaptures[index]?.dataUrl)
      .filter(Boolean) as string[];
    if (photoDataUrls.length < style.selectCount) return;
    setIsBusy(true);
    setPrintedPreview('');
    setPrintedNumber('');
    setIsAiGenerating(design.usesAi);
    setStep('thanks');

    const printFinal = async () => {
      const templateDataUrl = await window.photoBooth.getImageDataUrl(templateFramePath(design));
      const dataUrl = await createTemplatedPrintImage(photoDataUrls, style.id, design, templateDataUrl);
      const printerName = printerForStyle(settings, style.id);
      if (design.usesAi && design.aiPresetId) {
        await window.photoBooth.generateAiFinal({
          dataUrl,
          styleId: style.id,
          designId: design.id,
          presetId: design.aiPresetId,
          printerName
        });
        setPrintedPreview(dataUrl);
        setIsAiGenerating(false);
        return;
      }
      const saved = await window.photoBooth.saveImage({
        dataUrl,
        kind: 'final',
        filenamePrefix: 'final',
        styleId: style.id,
        designId: design.id,
        printerName
      });
      setPrintedPreview(dataUrl);
      setPrintedNumber(photoNumber(saved.name));
      setIsAiGenerating(false);
      void window.photoBooth.printImage(saved.path, printerName).then((result) => {
        if (!result.ok) console.warn(result.error || 'Print canceled.');
      });
    };

    try {
      await printFinal();
    } finally {
      setIsBusy(false);
    }
  };

  const printNow = async () => {
    if (!settings || !selectedDesign || selectedPhotoDataUrls.length < selectedStyle.selectCount) return;
    await printCaptures(captures, selectedCaptureIndexes, selectedStyle.id, selectedDesign);
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
      const style = getTemplateStyle(firstDesign?.styleId ?? 'style1');
      setSelectedStyleId(style.id);
      setSelectedDesignId(firstDesign?.id ?? '');
      setSelectedCaptureIndexes(Array.from({ length: style.selectCount }, (_item, index) => index).filter((index) => index < previewCaptures.length));
      setPrintedPreview('');
      setPrintedNumber('');
      setIsAiGenerating(false);
      setCountdown(null);
      setCaptureMessage('');
      setStep('select');
    } catch {
      setError('PREVIEW NOT READY');
      setStep('welcome');
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!settings || step !== 'select') {
      setPrintCountdown(null);
      return undefined;
    }
    const seconds = Math.ceil(settings.workflow.printAutoSelectMs / 1000);
    if (seconds <= 0) {
      setPrintCountdown(null);
      return undefined;
    }
    setPrintCountdown(seconds);
    const timer = window.setInterval(() => {
      setPrintCountdown((current) => (current === null ? current : Math.max(0, current - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [settings, step]);

  useEffect(() => {
    if (step !== 'select' || printCountdown !== 0 || isBusy || captures.length < 4) return;
    void printNow();
  }, [captures.length, isBusy, printCountdown, step]);

  if (!settings) return <GuestShell><p className="quiet">LOADING</p></GuestShell>;

  return (
    <GuestShell flash={isFlashing}>
      {!isFullscreen && step !== 'capture' && (
        <button
          className="fullscreen-button"
          aria-label="Fullscreen"
          title="Fullscreen"
          onClick={() => void window.photoBooth.setGuestFullscreen(true)}
        >
          <Expand size={18} />
        </button>
      )}

      {step === 'welcome' && (
        <section className="welcome-screen">
          <div>
            <p className="brand">{settings.eventName || 'AVIEBELLE PHOTO BOOTH'}</p>
            <button className="booth-button primary" onClick={() => setStep('style')} disabled={isBusy}>
              {buttonText('START')}
            </button>
          </div>
        </section>
      )}

      {step === 'style' && (
        <section className="template-guest-screen">
          <p className="instruction">CHOOSE A STYLE</p>
          {activeDesigns.length === 0 && <p className="quiet">ASK ADMIN TO ADD A TEMPLATE</p>}
          <div className="style-card-grid">
            {TEMPLATE_STYLES.map((style) => {
              const count = activeDesigns.filter((design) => design.styleId === style.id).length;
              return (
                <button key={style.id} className="style-card" onClick={() => chooseStyle(style.id)} disabled={count === 0}>
                  <TemplateMini styleId={style.id} />
                  <span>{style.name.toUpperCase()}</span>
                  <small>{style.shotCount} SHOTS / CHOOSE {style.selectCount}</small>
                  <small>{count} DESIGN{count === 1 ? '' : 'S'}</small>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {step === 'design' && (
        <section className="template-guest-screen">
          <button className="guest-back-button" onClick={() => setStep('style')}>
            {buttonText('BACK')}
          </button>
          <p className="instruction">CHOOSE A DESIGN</p>
          <p className="ai-disclaimer">AI can make mistake, don't be serious :)</p>
          <div className="design-card-grid">
            {activeDesigns
              .filter((design) => design.styleId === selectedStyleId)
              .map((design) => (
                <button key={design.id} className="design-card" onClick={() => chooseDesign(design)}>
                  <TemplateImagePreview design={design} />
                  <span>{design.name.toUpperCase()}</span>
                </button>
              ))}
          </div>
        </section>
      )}

      {step === 'intro' && (
        <section className="welcome-screen">
          <p className="brand">{settings.workflow.introMessage.toUpperCase()}</p>
        </section>
      )}

      {step === 'capture' && (
        <section className="capture-screen">
          <video ref={videoRef} className={getCameraVideoClass(settings)} playsInline muted />
          <div className="capture-progress">
            {captures.length + 1 <= selectedStyle.shotCount ? `${captures.length + 1} / ${selectedStyle.shotCount}` : `${selectedStyle.shotCount} / ${selectedStyle.shotCount}`}
          </div>
          <div className={`capture-guide-layer ${liveViewUsesFullScreen(selectedStyleId) ? 'full-screen' : ''}`} style={liveViewStyle(selectedStyleId, getPrimarySlot(selectedStyleId, captures.length))}>
            <div className="capture-print-guide" />
            {captureMessage && <div className="capture-message">{captureMessage}</div>}
            {countdown && <div className="countdown">{countdown}</div>}
          </div>
        </section>
      )}

      {step === 'select' && (
        <section className={`selection-screen ${getCameraOrientationClass(settings)}`}>
          <p className="instruction">
            {selectedStyle.selectCount === 1 ? 'PLEASE CHOOSE A PICTURE TO PRINT.' : `PLEASE CHOOSE ${selectedStyle.selectCount} PICTURES TO PRINT.`}
          </p>
          {selectedDesign && (
            <div className="selected-template-pill">
              <span>{selectedDesign.name.toUpperCase()}</span>
              {selectedDesign.usesAi && <strong>AI</strong>}
            </div>
          )}

          <div className={`selection-grid ${getCameraOrientationClass(settings)}`}>
            {captures.map((photo, index) => (
              <button
                key={photo.path}
                className={`selection-photo ${selectedCaptureIndexes.includes(index) ? 'selected' : ''}`}
                style={slotGuideStyle(getPrimarySlot(selectedStyleId, Math.min(index, selectedStyle.selectCount - 1)))}
                onClick={() => setSelectedCaptureIndexes(toggleSelectedIndex(selectedCaptureIndexes, index, selectedStyle.selectCount))}
              >
                <img src={photo.dataUrl} alt={`Captured photo ${index + 1}`} />
              </button>
            ))}
          </div>
          <button
            className="booth-button primary selection-print-button"
            onClick={printNow}
            disabled={isBusy || selectedPhotoDataUrls.length < selectedStyle.selectCount}
          >
            {buttonText(isBusy ? 'PRINTING' : printCountdown && printCountdown > 0 ? `PRINT NOW ${printCountdown}` : 'PRINT NOW')}
          </button>
        </section>
      )}

      {step === 'thanks' && (
        <section className="thanks-screen">
          {thankYouCountdown !== null && (
            <div className="thanks-top-actions">
              <div className="thanks-countdown">{thankYouCountdown}</div>
              <button onClick={resetGuestSession}>Restart</button>
            </div>
          )}
          {(printedPreview || isAiGenerating) && (
            <div className={`thanks-preview ${isAiGenerating ? 'generating' : ''}`}>
              {printedPreview && <img src={printedPreview} alt="Printed layout preview" />}
              {isAiGenerating && <span>GENERATING</span>}
            </div>
          )}
          <p className="brand">{settings.workflow.thankYouMessage.toUpperCase()}</p>
          {printedNumber && (
            <div className="pickup-number">
              <span>PHOTO NO.</span>
              <strong>{printedNumber}</strong>
              <span>REMEMBER IT TO FIND YOUR PIC</span>
            </div>
          )}
          {(isAiGenerating || selectedDesign?.usesAi) && <p className="ai-disclaimer">AI can make mistake, don't be serious :)</p>}
          {isAiGenerating && <p className="ai-wait-message">THIS WILL TAKE A BIT LONGER. PLEASE WAIT OUTSIDE NEAR THE PRINTING AREA.</p>}
        </section>
      )}

      {error && <p className="guest-error">{error}</p>}
    </GuestShell>
  );
}

function GuestShell({ children, flash = false }: { children: React.ReactNode; flash?: boolean }) {
  return (
    <main className="guest-shell">
      {children}
      <div className={`flash ${flash ? 'active' : ''}`} />
    </main>
  );
}

function TemplateMini({ styleId }: { styleId: TemplateStyleId }) {
  const style = getTemplateStyle(styleId);
  return (
    <div className="template-mini">
      {style.slots.map((slot, index) => (
        <span
          key={`${slot.x}-${slot.y}-${index}`}
          style={{
            left: `${(slot.x / TEMPLATE_WIDTH) * 100}%`,
            top: `${(slot.y / TEMPLATE_HEIGHT) * 100}%`,
            width: `${(slot.width / TEMPLATE_WIDTH) * 100}%`,
            height: `${(slot.height / TEMPLATE_HEIGHT) * 100}%`
          }}
        />
      ))}
    </div>
  );
}

function GuestViewOverlay({ styleId }: { styleId: TemplateStyleId }) {
  const slot = getPrimarySlot(styleId, 0);
  return (
    <div
      className={`admin-guest-view-overlay ${liveViewUsesFullScreen(styleId) ? 'full-screen' : ''}`}
      style={liveViewStyle(styleId, slot)}
      aria-hidden="true"
    >
      <span />
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

  return <div className="design-preview">{src ? <img src={src} alt={design.name} /> : <TemplateMini styleId={design.styleId} />}</div>;
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
  const [templateStyleId, setTemplateStyleId] = useState<TemplateStyleId>('style1');
  const [aiPresetDraft, setAiPresetDraft] = useState({ name: '', prompt: '' });
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

  const uploadTemplate = async (styleId: TemplateStyleId) => {
    try {
      const design = await window.photoBooth.uploadTemplate({ styleId });
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

  const saveGuide = async (styleId: TemplateStyleId) => {
    const dataUrl = await createGuideTemplateImage(styleId, settings.printCalibration);
    const filePath = await window.photoBooth.saveGuideTemplate(styleId, dataUrl);
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
        <p className="admin-title">AVIEBELLE</p>
        {[
          ['event', 'Event', Settings],
          ['camera', 'Camera', Camera],
          ['printer', 'Printer', Printer],
          ['workflow', 'Workflow', SlidersHorizontal],
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
                    {[
                      ['none', 'None'],
                      ['style1', 'Style 1'],
                      ['style2', 'Style 2'],
                      ['style3', 'Style 3'],
                      ['style4', 'Style 4']
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={settings.cameraPreviewOverlay === value ? 'active' : ''}
                        onClick={() =>
                          void saveMessage(
                            { cameraPreviewOverlay: value as AppSettings['cameraPreviewOverlay'] },
                            'Preview overlay saved.'
                          )
                        }
                      >
                        {label}
                      </button>
                    ))}
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
                  <video ref={cameraPreviewRef} className={getCameraVideoClass(settings)} muted playsInline />
                  {settings.cameraPreviewOverlay !== 'none' && (
                    <GuestViewOverlay styleId={settings.cameraPreviewOverlay} />
                  )}
                  {!adminStream && <span>No preview</span>}
                </div>
                <button className="admin-action" onClick={refreshCameras}><RefreshCw size={16} />Refresh cameras</button>
              </div>
            </div>
          </AdminSection>
        )}

        {tab === 'printer' && (
          <AdminSection>
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
                {TEMPLATE_STYLES.map((style) => (
                  <label key={style.id}>
                    {style.name} printer
                    <select
                      value={settings.stylePrinters[style.id]}
                      onChange={(event) =>
                        void saveMessage(
                          {
                            stylePrinters: {
                              ...settings.stylePrinters,
                              [style.id]: event.target.value
                            }
                          },
                          'Style printer saved.'
                        )
                      }
                    >
                      <option value="">Default printer</option>
                      {settings.stylePrinters[style.id] &&
                        !printers.some((printer) => printer.name === settings.stylePrinters[style.id]) && (
                          <option value={settings.stylePrinters[style.id]}>{settings.stylePrinters[style.id]}</option>
                        )}
                      {printers.map((printer) => (
                        <option key={`${style.id}-${printer.name}`} value={printer.name}>{printer.displayName || printer.name}</option>
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

            <div className="workflow-shots">
              {settings.workflow.shots.slice(0, 4).map((shot, index) => (
                <div className="workflow-shot" key={index}>
                  <h2>Picture {index + 1}</h2>
                  <label>
                    Message
                    <input
                      value={shot.message}
                      onChange={(event) => {
                        const shots = [...settings.workflow.shots];
                        shots[index] = { ...shot, message: event.target.value };
                        void saveMessage({ workflow: { ...settings.workflow, shots } }, 'Workflow saved.');
                      }}
                    />
                  </label>
                  <div className="workflow-grid">
                    <label>
                      Camera before message
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={msToSeconds(shot.cameraBeforeMessageMs)}
                        onChange={(event) => {
                          const shots = [...settings.workflow.shots];
                          shots[index] = { ...shot, cameraBeforeMessageMs: secondsToMs(event.target.value) };
                          void saveMessage({ workflow: { ...settings.workflow, shots } }, 'Workflow saved.');
                        }}
                      />
                    </label>
                    <label>
                      Message time
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={msToSeconds(shot.messageMs)}
                        onChange={(event) => {
                          const shots = [...settings.workflow.shots];
                          shots[index] = { ...shot, messageMs: secondsToMs(event.target.value) };
                          void saveMessage({ workflow: { ...settings.workflow, shots } }, 'Workflow saved.');
                        }}
                      />
                    </label>
                    <label>
                      Camera before countdown
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={msToSeconds(shot.cameraBeforeCountdownMs)}
                        onChange={(event) => {
                          const shots = [...settings.workflow.shots];
                          shots[index] = { ...shot, cameraBeforeCountdownMs: secondsToMs(event.target.value) };
                          void saveMessage({ workflow: { ...settings.workflow, shots } }, 'Workflow saved.');
                        }}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </AdminSection>
        )}

        {tab === 'template' && (
          <AdminSection>
            <div className="template-manager">
              <div className="template-style-tabs">
                {TEMPLATE_STYLES.map((style) => (
                  <button
                    key={style.id}
                    className={templateStyleId === style.id ? 'active' : ''}
                    onClick={() => setTemplateStyleId(style.id)}
                  >
                    {style.name}
                  </button>
                ))}
              </div>
              <div className="template-style-summary">
                <TemplateMini styleId={templateStyleId} />
                <div>
                  <h2>{getTemplateStyle(templateStyleId).name}</h2>
                  <p>{getTemplateStyle(templateStyleId).shotCount} shots / choose {getTemplateStyle(templateStyleId).selectCount}</p>
                  <p>{TEMPLATE_WIDTH} x {TEMPLATE_HEIGHT} frame PNG. Finals save at {PRINT_WIDTH} x {PRINT_HEIGHT}.</p>
                  <div className="admin-actions">
                    <button onClick={() => void saveGuide(templateStyleId)}>Download blank guide</button>
                    <button onClick={() => void uploadTemplate(templateStyleId)}>Add print frame PNG</button>
                  </div>
                </div>
              </div>
              <div className="template-design-grid">
                {settings.template.designs
                  .filter((design) => design.styleId === templateStyleId)
                  .map((design) => (
                    <article className="template-design-admin" key={design.id}>
                      <TemplateImagePreview design={design} />
                      <input
                        value={design.name}
                        onChange={(event) => void saveTemplateDesign({ ...design, name: event.target.value })}
                      />
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={design.active}
                          onChange={(event) => void saveTemplateDesign({ ...design, active: event.target.checked })}
                        />
                        Active
                      </label>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={design.usesAi}
                          onChange={(event) => void saveTemplateDesign({ ...design, usesAi: event.target.checked })}
                        />
                        AI frame
                      </label>
                      {design.usesAi && (
                        <label>
                          AI preset
                          <select
                            value={design.aiPresetId}
                            onChange={(event) => void saveTemplateDesign({ ...design, aiPresetId: event.target.value })}
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
                      <div className="template-path-note">
                        <span>Preview: {shortPath(templatePreviewPath(design))}</span>
                        <span>Print frame: {shortPath(templateFramePath(design))}</span>
                      </div>
                      <div className="admin-actions">
                        <button onClick={() => void updateTemplateAsset(design, 'preview')}>Upload preview</button>
                        <button onClick={() => void updateTemplateAsset(design, 'frame')}>Upload print frame</button>
                        <button onClick={() => window.photoBooth.openFile(templateFramePath(design))}>Open frame</button>
                        <button className="danger" onClick={() => void deleteTemplateDesign(design)}>Delete</button>
                      </div>
                    </article>
                  ))}
              </div>
              {settings.template.designs.filter((design) => design.styleId === templateStyleId).length === 0 && (
                <p className="muted">No designs uploaded for this style yet.</p>
              )}
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

function AdminSection({ children }: { children: React.ReactNode }) {
  return <div className="admin-section">{children}</div>;
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
  const controls = CAMERA_CONTROL_FIELDS.filter((field) => capabilities[field.key]);
  if (controls.length === 0) {
    return <p className="muted">This camera does not expose image controls to Electron.</p>;
  }

  return (
    <div className="camera-control-list">
      {controls.map((field) => {
        const capability = capabilities[field.key];
        if (!capability) return null;
        const step = capability.step || 1;
        const value = values[field.key] ?? defaultCameraControlValue(capability);
        return (
          <label key={field.key}>
            {field.label}
            <div className="range-row">
              <input
                type="range"
                min={capability.min}
                max={capability.max}
                step={step}
                value={value}
                onChange={(event) => onChange(field.key, Number(event.target.value))}
              />
              <input
                type="number"
                min={capability.min}
                max={capability.max}
                step={step}
                value={value}
                onChange={(event) => onChange(field.key, Number(event.target.value))}
              />
            </div>
          </label>
        );
      })}
    </div>
  );
}

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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

const templatePreviewPath = (design: TemplateDesign) => design.previewPath || design.filePath || design.framePath;

const templateFramePath = (design: TemplateDesign) => design.framePath || design.filePath || design.previewPath;

const shortPath = (filePath: string) => filePath.split(/[\\/]/).slice(-2).join('/');

const printerForStyle = (settings: AppSettings, styleId: TemplateStyleId) =>
  settings.stylePrinters[styleId] || settings.defaultPrinter;

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

type CameraRangeCapability = {
  min: number;
  max: number;
  step?: number;
};

type CameraCapabilitiesMap = Partial<Record<CameraControlKey, CameraRangeCapability>>;

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
    if (!capability) return next;
    const requestedValue = field.key === 'zoom' ? 0 : 50;
    next[field.key] = Math.min(capability.max, Math.max(capability.min, requestedValue));
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

const styleNeedsSelection = (styleId: TemplateStyleId) => styleId === 'style1' || styleId === 'style2';

const liveViewUsesFullScreen = (styleId: TemplateStyleId) => styleId === 'style1' || styleId === 'style3';

const liveViewStyle = (styleId: TemplateStyleId, slot: Pick<TemplateSlot, 'width' | 'height' | 'cropY'>) =>
  liveViewUsesFullScreen(styleId) ? ({} as CSSProperties) : slotGuideStyle(slot);

const slotGuideStyle = (slot: Pick<TemplateSlot, 'width' | 'height' | 'cropY'>) =>
  ({
    aspectRatio: `${slot.width} / ${slot.height}`,
    '--slot-aspect': slot.width / slot.height
  }) as CSSProperties;

const cropCanvasToSlot = (sourceCanvas: HTMLCanvasElement, slot: Pick<TemplateSlot, 'width' | 'height' | 'cropY'>) => {
  const targetAspect = slot.width / slot.height;
  const sourceAspect = sourceCanvas.width / sourceCanvas.height;
  let cropWidth = sourceCanvas.width;
  let cropHeight = sourceCanvas.height;
  let cropX = 0;
  let cropY = 0;

  if (sourceAspect > targetAspect) {
    cropWidth = sourceCanvas.height * targetAspect;
    cropX = (sourceCanvas.width - cropWidth) / 2;
  } else {
    cropHeight = sourceCanvas.width / targetAspect;
    cropY = slot.cropY === 'top' ? 0 : (sourceCanvas.height - cropHeight) / 2;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cropWidth);
  canvas.height = Math.round(cropHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not ready.');
  ctx.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
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
