import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Download, Expand, ExternalLink, FolderOpen, Grid2X2, Image, Minimize2, Printer, RefreshCw, Settings, SlidersHorizontal, Sparkles, Square, Trash2 } from 'lucide-react';
import type { AppSettings, Capture, Gallery, PrintLayout, SavedPhoto } from './types';
import { createGridPrintImage, createSinglePrintImage } from './template';

type GuestStep = 'welcome' | 'intro' | 'capture' | 'select' | 'thanks';

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
  const { settings } = useSettings();
  const [step, setStep] = useState<GuestStep>('welcome');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [captureMessage, setCaptureMessage] = useState('');
  const [error, setError] = useState('');
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedCaptureIndex, setSelectedCaptureIndex] = useState(0);
  const [printLayout, setPrintLayout] = useState<PrintLayout>('single');
  const [printedPreview, setPrintedPreview] = useState('');
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
    if (step !== 'thanks') return undefined;
    const timer = window.setTimeout(() => {
      setCaptures([]);
      setSelectedCaptureIndex(0);
      if (settings) setPrintLayout(defaultPrintLayout(settings));
      setPrintedPreview('');
      setCountdown(null);
      setCaptureMessage('');
      setError('');
      setStep('welcome');
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [settings, step]);

  useEffect(() => {
    if (!settings || isPrintLayoutVisible(printLayout, settings)) return;
    setPrintLayout(defaultPrintLayout(settings));
  }, [printLayout, settings]);

  useEffect(() => {
    return () => {
      sessionRunRef.current += 1;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const startCamera = async () => {
    if (!settings) throw new Error('Settings not ready.');
    const constraints: MediaStreamConstraints = {
      video: settings.cameraId ? { deviceId: { exact: settings.cameraId } } : { width: 1920, height: 1080 },
      audio: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    streamRef.current = stream;
    await waitFor(() => videoRef.current);
    if (!videoRef.current) throw new Error('Camera view not ready.');
    videoRef.current.srcObject = stream;
    await videoRef.current.play();
  };

  const captureFrame = async () => {
    if (!videoRef.current || !settings) throw new Error('Camera not ready.');
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not ready.');
    if (settings.mirrorPreview) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
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

  const startSession = async () => {
    if (!settings || isBusy) return;
    const runId = sessionRunRef.current + 1;
    sessionRunRef.current = runId;
    setError('');
    setIsBusy(true);
    setCaptures([]);
    setSelectedCaptureIndex(0);
    setPrintLayout(defaultPrintLayout(settings));
    setPrintedPreview('');
    setCaptureMessage('');
    setCountdown(null);

    try {
      setStep('intro');
      await delay(settings.workflow.introMs);
      if (sessionRunRef.current !== runId) return;
      setStep('capture');
      await delay(100);
      await startCamera();

      const shotPlan = settings.workflow.shots.slice(0, 4);
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
        const capture = await captureFrame();
        nextCaptures.push(capture);
        setCaptures([...nextCaptures]);
        await delay(350);
      }

      stopCamera();
      setSelectedCaptureIndex(0);
      setStep('select');
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

  const printNow = async () => {
    if (!settings || captures.length < 4 || printLayout === 'ai' || printLayout === 'future') return;
    setIsBusy(true);
    try {
      const dataUrl =
        printLayout === 'grid'
          ? await createGridPrintImage(captures.map((capture) => capture.dataUrl))
          : await createSinglePrintImage(captures[selectedCaptureIndex]?.dataUrl ?? captures[0].dataUrl);
      const saved = await window.photoBooth.saveImage({ dataUrl, kind: 'final', filenamePrefix: 'final' });
      setPrintedPreview(dataUrl);
      const result = await window.photoBooth.printImage(saved.path);
      if (!result.ok) setError('PRINT CANCELED');
      setStep('thanks');
    } finally {
      setIsBusy(false);
    }
  };

  if (!settings) return <GuestShell><p className="quiet">LOADING</p></GuestShell>;

  return (
    <GuestShell flash={isFlashing}>
      {!isFullscreen && (
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
            <button className="booth-button primary" onClick={startSession} disabled={isBusy}>
              {buttonText('START')}
            </button>
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
          <video ref={videoRef} className={settings.mirrorPreview ? 'mirror' : ''} playsInline muted />
          <div className="capture-progress">{captures.length + 1 <= 4 ? `${captures.length + 1} / 4` : '4 / 4'}</div>
          {captureMessage && <div className="capture-message">{captureMessage}</div>}
          {countdown && <div className="countdown">{countdown}</div>}
        </section>
      )}

      {step === 'select' && (
        <section className="selection-screen">
          <p className="instruction">
            {printLayout === 'grid' ? 'PRINT ALL 4 IMAGES.' : 'PLEASE CHOOSE A PICTURE TO PRINT.'}
          </p>
          <div className="print-mode-row">
            {settings.printPicker.showSingle && (
              <PrintModeButton layout="single" current={printLayout} onSelect={setPrintLayout} label="Large">
                <Square size={28} />
              </PrintModeButton>
            )}
            {settings.printPicker.showGrid && (
              <PrintModeButton layout="grid" current={printLayout} onSelect={setPrintLayout} label="Grid">
                <Grid2X2 size={28} />
              </PrintModeButton>
            )}
            {settings.printPicker.showAi && (
              <PrintModeButton layout="ai" current={printLayout} onSelect={setPrintLayout} label="AI" disabled>
                <span className="ai-icon">AI</span>
              </PrintModeButton>
            )}
            {settings.printPicker.showFuture && (
              <PrintModeButton layout="future" current={printLayout} onSelect={setPrintLayout} label="Soon" disabled>
                <Sparkles size={28} />
              </PrintModeButton>
            )}
          </div>

          <div className="selection-grid">
            {captures.map((photo, index) => (
              <button
                key={photo.path}
                className={`selection-photo ${selectedCaptureIndex === index || printLayout === 'grid' ? 'selected' : ''}`}
                onClick={() => setSelectedCaptureIndex(index)}
              >
                <img src={photo.dataUrl} alt={`Captured photo ${index + 1}`} />
              </button>
            ))}
          </div>
          <button className="booth-button primary" onClick={printNow} disabled={isBusy || captures.length < 4}>
            {buttonText(isBusy ? 'PRINTING' : 'PRINT NOW')}
          </button>
        </section>
      )}

      {step === 'thanks' && (
        <section className="thanks-screen">
          {printedPreview && (
            <div className="thanks-preview">
              <img src={printedPreview} alt="Printed layout preview" />
            </div>
          )}
          <p className="brand">THANK YOU!</p>
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

function PrintModeButton({
  layout,
  current,
  onSelect,
  label,
  disabled = false,
  children
}: {
  layout: PrintLayout;
  current: PrintLayout;
  onSelect: (layout: PrintLayout) => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`print-mode-button ${current === layout ? 'active' : ''}`}
      onClick={() => onSelect(layout)}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function AdminApp() {
  const { settings, updateSettings } = useSettings();
  const [tab, setTab] = useState('event');
  const [gallery, setGallery] = useState<Gallery>({ originals: [], finals: [] });
  const [printers, setPrinters] = useState<Electron.PrinterInfo[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [message, setMessage] = useState('');
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const [adminStream, setAdminStream] = useState<MediaStream | null>(null);

  const refreshGallery = async () => setGallery(await window.photoBooth.listGallery());
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
    void refreshPrinters();
    void refreshCameras();
  }, []);

  useEffect(() => {
    if (tab !== 'camera' || !settings) return undefined;
    let stream: MediaStream | null = null;
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: settings.cameraId ? { deviceId: { exact: settings.cameraId } } : true,
          audio: false
        });
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
    };
  }, [settings, tab]);

  const latestFinal = useMemo(() => gallery.finals[0], [gallery]);

  if (!settings) return <main className="admin-shell"><p>Loading</p></main>;

  const saveMessage = async (partial: Partial<AppSettings>, text = 'Saved.') => {
    const next = await updateSettings(partial);
    setMessage(text);
    window.setTimeout(() => setMessage(''), 2200);
    return next;
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
          {message && <p>{message}</p>}
        </header>

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
            <div className="admin-preview">
              <video ref={cameraPreviewRef} className={settings.mirrorPreview ? 'mirror' : ''} muted playsInline />
              {!adminStream && <span>No preview</span>}
            </div>
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
            <button className="admin-action" onClick={refreshCameras}><RefreshCw size={16} />Refresh cameras</button>
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
            <div className="workflow-shot">
              <h2>Print calibration</h2>
              <div className="workflow-grid">
                <label>
                  Horizontal offset
                  <input
                    type="number"
                    step="0.01"
                    value={settings.printCalibration.offsetXIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            offsetXIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Vertical offset
                  <input
                    type="number"
                    step="0.01"
                    value={settings.printCalibration.offsetYIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            offsetYIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Horizontal bleed
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.bleedXIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            bleedXIn: Number(event.target.value)
                          }
                        },
                        'Print calibration saved.'
                      )
                    }
                  />
                </label>
                <label>
                  Vertical bleed
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.printCalibration.bleedYIn}
                    onChange={(event) =>
                      void saveMessage(
                        {
                          printCalibration: {
                            ...settings.printCalibration,
                            bleedYIn: Number(event.target.value)
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
              <button onClick={() => latestFinal && window.photoBooth.printImage(latestFinal.path)}><Printer size={16} />Reprint last photo</button>
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

            <div className="workflow-shot">
              <h2>Picture picking screen</h2>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.printPicker.showSingle}
                  onChange={(event) =>
                    void saveMessage(
                      {
                        printPicker: {
                          ...settings.printPicker,
                          showSingle: event.target.checked,
                          showGrid: event.target.checked ? settings.printPicker.showGrid : true
                        }
                      },
                      'Print options saved.'
                    )
                  }
                />
                Show single image option
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.printPicker.showGrid}
                  onChange={(event) =>
                    void saveMessage(
                      {
                        printPicker: {
                          ...settings.printPicker,
                          showGrid: event.target.checked,
                          showSingle: event.target.checked ? settings.printPicker.showSingle : true
                        }
                      },
                      'Print options saved.'
                    )
                  }
                />
                Show 4 image grid option
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.printPicker.showAi}
                  onChange={(event) =>
                    void saveMessage({ printPicker: { ...settings.printPicker, showAi: event.target.checked } }, 'Print options saved.')
                  }
                />
                Show AI option
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.printPicker.showFuture}
                  onChange={(event) =>
                    void saveMessage({ printPicker: { ...settings.printPicker, showFuture: event.target.checked } }, 'Print options saved.')
                  }
                />
                Show future option
              </label>
            </div>
          </AdminSection>
        )}

        {tab === 'template' && (
          <AdminSection>
            <div className="template-preview">
              <div className="template-photo" />
              <p>{(settings.template.eventName || settings.eventName).toUpperCase()}</p>
            </div>
            <label>
              Template event text
              <input
                value={settings.template.eventName}
                onChange={(event) => void saveMessage({ template: { ...settings.template, eventName: event.target.value } }, 'Template saved.')}
              />
            </label>
            <div className="admin-actions">
              <button onClick={async () => {
                const logoPath = await window.photoBooth.chooseImage();
                if (logoPath) await saveMessage({ template: { ...settings.template, logoPath } }, 'Logo saved.');
              }}>Choose logo</button>
              <button onClick={async () => {
                const framePath = await window.photoBooth.chooseImage();
                if (framePath) await saveMessage({ template: { ...settings.template, framePath } }, 'Frame saved.');
              }}>Choose frame</button>
            </div>
          </AdminSection>
        )}

        {tab === 'gallery' && (
          <AdminSection>
            <div className="admin-actions">
              <button onClick={refreshGallery}><RefreshCw size={16} />Refresh gallery</button>
            </div>
            <GalleryList title="Finals" photos={gallery.finals} onChanged={refreshGallery} />
            <GalleryList title="Originals" photos={gallery.originals} onChanged={refreshGallery} />
          </AdminSection>
        )}
      </section>
    </main>
  );
}

function AdminSection({ children }: { children: React.ReactNode }) {
  return <div className="admin-section">{children}</div>;
}

function GalleryList({ title, photos, onChanged }: { title: string; photos: SavedPhoto[]; onChanged: () => Promise<void> }) {
  return (
    <div className="gallery-list">
      <h2>{title}</h2>
      {photos.length === 0 && <p className="muted">No photos yet.</p>}
      <div className="gallery-card-grid">
        {photos.map((photo) => (
          <GalleryCard key={photo.path} photo={photo} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

function GalleryCard({ photo, onChanged }: { photo: SavedPhoto; onChanged: () => Promise<void> }) {
  const [imageSrc, setImageSrc] = useState('');

  useEffect(() => {
    let active = true;
    void window.photoBooth
      .getImageDataUrl(photo.path)
      .then((dataUrl) => {
        if (active) setImageSrc(dataUrl);
      })
      .catch(() => {
        if (active) setImageSrc('');
      });
    return () => {
      active = false;
    };
  }, [photo.path]);

  return (
    <article className="gallery-card">
      <div className="gallery-card-thumb">
        {imageSrc ? <img src={imageSrc} alt={photo.name} /> : <Image size={34} />}
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
          <button title="Print" aria-label={`Print ${photo.name}`} onClick={() => window.photoBooth.printImage(photo.path)}>
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

const defaultPrintLayout = (settings: AppSettings): PrintLayout =>
  settings.printPicker.showSingle ? 'single' : settings.printPicker.showGrid ? 'grid' : 'single';

const isPrintLayoutVisible = (layout: PrintLayout, settings: AppSettings) => {
  if (layout === 'single') return settings.printPicker.showSingle;
  if (layout === 'grid') return settings.printPicker.showGrid;
  if (layout === 'ai') return settings.printPicker.showAi;
  return settings.printPicker.showFuture;
};
