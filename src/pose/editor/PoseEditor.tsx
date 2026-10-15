import { applySpeechTiming, hasMatchingSpeechTiming } from '../../../electron/poseAlignment';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Mic } from 'lucide-react';
import type { AppSettings } from '../../types';
import { getAudioCueElement, pauseAudioCue, playAudioCueObject, resumeAudioCue, seekAudioCue, stopAudioCue } from '../../audio';
import { isBundledPoseAsset, resolvePoseAsset } from '../assets';
import { loadPhotoGuideCatalog } from '../repository';
import { BUNDLED_SCENES, PHOTO_GUIDE_SCENES, captionAt, sceneMatches } from '../scenes';
import { validateScene } from '../validation';
import { type GuestComposition, type ParticipantRole, type PoseScene, type PoseStyle } from '../types';
import { ScenePlayer } from '../ScenePlayer';
import { createPoseAudioHooks } from '../audio';
import { CompositionControls } from '../GuestCompositionScreen';
import { NumberField, TextField } from './Fields';
import { cloneScene, fitSceneToNarration } from './operations';
import { readNarration } from './narration';

const CUE = 'pose-editor-narration';
const newId = () => `custom-${crypto.randomUUID()}`;
const peopleLabel = (scene: PoseScene) => `${scene.compatibility.minPeople}${scene.compatibility.maxPeople === null ? '+' : scene.compatibility.maxPeople > scene.compatibility.minPeople ? `–${scene.compatibility.maxPeople}` : ''}`;
const spokenCue = (value: string) => value
  .trim()
  .replace(/^(find your mark|get ready|start|begin)\b[.!]?$/i, '')
  .replace(/\s+/g, ' ')
  .replace(/\s+([,.!?])/g, '$1')
  .trim();
const captionScript = (scene: PoseScene) => {
  const cues = scene.animation.captions.map(frame => spokenCue(frame.text)).filter((text, index, all) => text && all.indexOf(text) === index);
  if (!cues.length) return '';
  return cues.map((text, index) => {
    const line = text.charAt(0).toUpperCase() + text.slice(1).replace(/[.!?]+$/, '');
    if (index === cues.length - 1) return `${line}!`;
    return `${line}.`;
  }).join(' ');
};

function PoseGalleryCard({ scene, onOpen }: { scene: PoseScene; onOpen: () => void }) {
  const assetPath = scene.visual?.assetPath ?? '';
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!assetPath) { setSrc(''); return; }
    if (isBundledPoseAsset(assetPath)) { setSrc(`/${assetPath}`); return; }
    let cancelled = false;
    void resolvePoseAsset(assetPath).then(url => { if (!cancelled) setSrc(url); });
    return () => { cancelled = true; };
  }, [assetPath]);
  const framing = scene.compatibility.framing.map(mode => mode === 'full' ? 'Full' : 'Half').join(' · ');
  return <button type="button" className="pose-gallery-card" onClick={onOpen}>
    <span className="pose-gallery-thumb" style={{ background: scene.visual?.accent ? `color-mix(in srgb, ${scene.visual.accent} 24%, #121212)` : '#171717' }}>
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <span className="pose-gallery-missing">No photo</span>}
      <span className="pose-gallery-badge">{framing}</span>
      {scene.audio?.filePath ? <span className="pose-gallery-voice" role="img" aria-label="Voice narration assigned" title="Voice narration assigned"><Mic size={16} aria-hidden="true" /></span> : null}
    </span>
    <strong>{scene.name}</strong>
    <small>{scene.category} · {peopleLabel(scene)}</small>
  </button>;
}
export function PoseEditor({ settings }: { settings: AppSettings }) {
  const [catalog, setCatalog] = useState<PoseScene[]>(PHOTO_GUIDE_SCENES);
  const [draft, setDraft] = useState<PoseScene>(() => cloneScene(PHOTO_GUIDE_SCENES[0]));
  const [saved, setSaved] = useState<PoseScene>(() => cloneScene(PHOTO_GUIDE_SCENES[0]));
  const [past, setPast] = useState<PoseScene[]>([]), [future, setFuture] = useState<PoseScene[]>([]);
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [framing, setFraming] = useState<'full' | 'half'>('full');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [librarySearch, setLibrarySearch] = useState(''), [libraryCategory, setLibraryCategory] = useState('all');
  const [narration, setNarration] = useState({ dataUrl: '', durationMs: 0 });
  const [narrationMessage, setNarrationMessage] = useState('');
  const [previewGroup, setPreviewGroup] = useState<GuestComposition>({ men: 1, women: 0, boys: 0, girls: 0, style: 'solo' });
  const [countdownPreview, setCountdownPreview] = useState<number | null>(null);
  const [cutoutSrc, setCutoutSrc] = useState('');
  const [page, setPage] = useState<'gallery' | 'detail'>('gallery');
  const [aiDescription, setAiDescription] = useState('');
  const [aiProvider, setAiProvider] = useState(settings.ai.poseGenerator.provider);
  const player = useRef<ScenePlayer | null>(null), countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const galleryScrollTop = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const bundled = BUNDLED_SCENES.some(scene => scene.id === draft.id);
  const photo = draft.visual?.kind === 'photo-cutout';
  const libraryCategories = useMemo(() => [...new Set(catalog.map(scene => scene.category))].sort(), [catalog]);
  const visibleCatalog = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    return catalog.filter(scene => (libraryCategory === 'all' || scene.category === libraryCategory) && (!query || `${scene.name} ${scene.category} ${scene.tags.join(' ')} ${scene.instruction}`.toLowerCase().includes(query)));
  }, [catalog, libraryCategory, librarySearch]);
  const caption = captionAt(draft, time).caption;
  const [narrationScript, setNarrationScript] = useState('');
  const [syncingAll, setSyncingAll] = useState(false);
  const cancelSync = useRef(false);
  useEffect(() => () => { cancelSync.current = true; }, []);
  const refresh = async () => { const result = await loadPhotoGuideCatalog(); setCatalog(result.poses); if (result.errors.length) setMessage(result.errors.join('\n')); };
  useEffect(() => { void refresh(); }, []);
  useLayoutEffect(() => {
    const panel = document.querySelector<HTMLElement>('.admin-panel');
    if (panel) panel.scrollTop = page === 'gallery' ? galleryScrollTop.current : 0;
  }, [page, draft.id]);
  useEffect(() => { setNarrationScript(''); }, [draft.id]);
  useEffect(() => {
    const assetPath = draft.visual?.assetPath;
    if (!assetPath) { setCutoutSrc(''); return; }
    let cancelled = false;
    void resolvePoseAsset(assetPath).then(src => { if (!cancelled) setCutoutSrc(src); });
    return () => { cancelled = true; };
  }, [draft.visual?.assetPath]);
  useEffect(() => { setAiProvider(settings.ai.poseGenerator.provider); }, [settings.ai.poseGenerator.provider]);
  useEffect(() => { setTime(value => Math.min(value, draft.animation.durationMs)); }, [draft.animation.durationMs]);
  useEffect(() => {
    let cancelled = false; setNarration({ dataUrl: '', durationMs: 0 });
    if (draft.audio?.filePath) void readNarration(draft.audio.filePath).then(result => { if (!cancelled) setNarration(result); }).catch(error => { if (!cancelled) setMessage(String(error)); });
    return () => { cancelled = true; stopAudioCue(CUE); };
  }, [draft.audio?.filePath]);
  useEffect(() => () => { stopAudioCue(CUE); player.current?.dispose(); if (countdownTimer.current) clearTimeout(countdownTimer.current); }, []);
  const stopPreview = () => { setPlaying(false); pauseAudioCue(CUE); player.current?.stop(); if (countdownTimer.current) clearTimeout(countdownTimer.current); setCountdownPreview(null); };
  function apply(operation: (scene: PoseScene) => PoseScene) {
    stopPreview();
    try {
      const next = operation(cloneScene(draft));
      validateScene(next);
      setPast(history => [...history.slice(-49), cloneScene(draft)]); setFuture([]); setDraft(next); setMessage('');
    } catch (error) { setMessage(String(error)); }
  }
  const select = (scene: PoseScene) => {
    if (dirty && !window.confirm('Discard unsaved pose changes?')) return false;
    stopPreview(); stopAudioCue(CUE); setDraft(cloneScene(scene)); setSaved(cloneScene(scene)); setPast([]); setFuture([]); setTime(0); setMessage('');
    return true;
  };
  const openScene = (scene: PoseScene) => {
    if (!select(scene)) return;
    if (page === 'gallery') galleryScrollTop.current = document.querySelector<HTMLElement>('.admin-panel')?.scrollTop ?? 0;
    setPage('detail');
  };
  const backToGallery = () => {
    if (dirty && !window.confirm('Discard unsaved pose changes?')) return;
    stopPreview(); stopAudioCue(CUE); setDraft(cloneScene(saved)); setPast([]); setFuture([]); setTime(0); setPage('gallery');
  };
  const blankPose = (): PoseScene => {
    const base = cloneScene(PHOTO_GUIDE_SCENES[0]);
    return { ...base, id: newId(), name: 'New pose', instruction: 'Hold the pose', roles: [{ role: 'any', repeatable: false }], compatibility: { minPeople: 1, maxPeople: 1, styles: ['solo'], framing: ['half'], childSafe: true }, animation: { durationMs: 7000, captions: [{ timeMs: 0, text: 'Hold the final pose' }] } };
  };
  const setClock = (next: number) => { stopPreview(); setTime(next); seekAudioCue(CUE, Math.max(0, next - (draft.audio?.startMs ?? 0)) / 1000); };
  useEffect(() => {
    if (!playing) return;
    let active = true, frame = 0, audioStarted = false, audioPending = false, lastRender = -100;
    let previewAudio: HTMLAudioElement | null = null, endedAt: number | null = null;
    const from = time >= draft.animation.durationMs ? 0 : time, began = performance.now();
    const tick = () => {
      if (!active) return;
      let next = Math.min(draft.animation.durationMs, from + performance.now() - began);
      if (audioPending && !audioStarted) next = from;
      if (previewAudio?.currentSrc && !previewAudio.error && Number.isFinite(previewAudio.duration)) {
        if (previewAudio.ended && endedAt === null) endedAt = performance.now();
        next = Math.min(draft.animation.durationMs, (draft.audio?.startMs ?? 0) + previewAudio.currentTime * 1000 + (endedAt === null ? 0 : performance.now() - endedAt));
      }
      if (narration.dataUrl && draft.audio && settings.audio.enabled && !audioStarted && !audioPending && next >= (draft.audio.startMs ?? 0)) {
        audioPending = true;
        void playAudioCueObject(settings, { id: CUE, label: draft.name, mode: 'mp3', channel: 'voice', text: '', filePath: draft.audio.filePath, enabled: true, loop: false, volume: 1, updatedAt: '' }, '', narration.dataUrl).then(async () => {
          if (!active) { pauseAudioCue(CUE); return; }
          seekAudioCue(CUE, Math.max(0, from - (draft.audio?.startMs ?? 0)) / 1000); await resumeAudioCue(CUE); previewAudio = getAudioCueElement(CUE); audioStarted = true; audioPending = false;
        }).catch(error => { audioStarted = true; audioPending = false; setMessage(String(error)); });
      }
      if (next - lastRender >= 32 || next === draft.animation.durationMs) { setTime(Math.round(next)); lastRender = next; }
      if (next >= draft.animation.durationMs) { setPlaying(false); pauseAudioCue(CUE); return; }
      frame = requestAnimationFrame(tick);
    };
    tick(); return () => { active = false; cancelAnimationFrame(frame); pauseAudioCue(CUE); };
    // Playback captures a stable draft and start time; scrubbing pauses first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  async function completePreview() {
    stopPreview(); setBusy(true);
    try {
      player.current?.dispose();
      player.current = new ScenePlayer(frame => setTime(Math.round(frame.elapsedMs)), createPoseAudioHooks(() => settings));
      const result = await player.current.play(cloneScene(draft));
      if (result === 'completed') {
        let number = 3; setCountdownPreview(number);
        const advance = () => { number--; setCountdownPreview(number > 0 ? number : null); if (number > 0) countdownTimer.current = setTimeout(advance, 1000); };
        countdownTimer.current = setTimeout(advance, 1000);
      }
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  const write = async (action: () => Promise<unknown>, success: string) => { setBusy(true); try { await action(); setMessage(success); } catch (error) { setMessage(String(error)); } finally { setBusy(false); } };
  const save = () => write(async () => {
    let scene = validateScene(cloneScene(draft));
    scene = fitSceneToNarration(scene, narration.durationMs);
    const stored = await window.photoBooth.savePose(scene); setDraft(stored); setSaved(cloneScene(stored)); await refresh();
  }, 'Pose saved. It will be available next session.');
  const updatePoseGenerator = async (provider: typeof aiProvider, patch: Partial<{ apiUrl: string; model: string }> = {}) => {
    const current = settings.ai.poseGenerator;
    await window.photoBooth.updateSettings({ ai: { ...settings.ai, poseGenerator: { provider, providers: { ...current.providers, [provider]: { ...current.providers[provider], ...patch } } } } });
  };
  const generatePose = async () => {
    if (dirty && !window.confirm('Replace the current unsaved changes with an AI draft?')) return;
    stopPreview(); setBusy(true); setMessage('Generating a validated pose draft…');
    try {
      const result = await window.photoBooth.generatePose({ description: aiDescription.trim(), provider: aiProvider });
      const next = validateScene(result.scene);
      setPast(history => [...history.slice(-49), cloneScene(draft)]); setFuture([]); setDraft(next); setTime(next.animation.durationMs);
      setMessage(`AI draft ready from ${result.provider} (${result.model}). Preview, adjust, then save it.`);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const generateNarration = async () => {
    stopPreview(); stopAudioCue(CUE); setBusy(true); setNarrationMessage('Generating narration with ElevenLabs…'); setMessage('');
    try {
      const result = await window.photoBooth.generatePoseNarration({ poseId: draft.id, text: narrationScript.trim(), captions: draft.animation.captions.map(caption => spokenCue(caption.text)).filter((text, index, all) => text && all.indexOf(text) === index) });
      const audio = await readNarration(result.filePath);
      if (!result.speechTiming) throw new Error('Speech timestamps were not returned. Try syncing captions for this recording.');
      apply(scene => applySpeechTiming({ ...scene, audio: { filePath: result.filePath, startMs: 0, markers: [] } }, result.speechTiming!));
      setNarration(audio);
      const success = `${result.cached ? 'Loaded cached' : 'Generated'} narration: ${result.name}. Pose timing and captions were set automatically.`;
      setNarrationMessage(success); setMessage(success);
    } catch (error) { const failure = error instanceof Error ? error.message : String(error); setNarrationMessage(failure); setMessage(failure); }
    finally { setBusy(false); }
  };
  const syncCaptions = async () => {
    stopPreview(); setBusy(true); setNarrationMessage('Matching captions to the saved recording…');
    try {
      const next = await window.photoBooth.syncPoseNarration(cloneScene(draft));
      apply(() => next);
      setNarrationMessage('Captions synced to speech. Save the pose to keep the timing.');
    } catch (error) { setNarrationMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const syncAllCaptions = async () => {
    if (busy || syncingAll) return;
    cancelSync.current = false; setSyncingAll(true); setBusy(true);
    let synced = 0, skipped = 0;
    const failures: string[] = [];
    try {
      const library = await loadPhotoGuideCatalog();
      for (const [index, scene] of library.poses.entries()) {
        if (cancelSync.current) break;
        if (hasMatchingSpeechTiming(scene)) { skipped++; continue; }
        setMessage(`Syncing captions ${index + 1}/${library.poses.length}: ${scene.name}`);
        try {
          const next = await window.photoBooth.syncPoseNarration(scene);
          await window.photoBooth.savePose(next); synced++;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`${scene.name}: ${detail}`);
          if (/401|402|403|permission|API key|quota/i.test(detail)) break;
        }
      }
      await refresh();
      setMessage(`${cancelSync.current ? 'Stopped. ' : ''}${synced} poses synced; ${skipped} already synced; ${failures.length} failed.${failures.length ? '\n' + failures.join('\n') : ''}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSyncingAll(false); setBusy(false); }
  };
  const playNarration = async () => {
    if (!draft.audio || !narration.dataUrl) return;
    stopPreview(); stopAudioCue(CUE);
    try { await playAudioCueObject(settings, { id: CUE, label: draft.name, mode: 'mp3', channel: 'voice', text: narrationScript, filePath: draft.audio.filePath, enabled: true, loop: false, volume: 1, updatedAt: '' }, '', narration.dataUrl); }
    catch (error) { setMessage(String(error)); }
  };
  const gallery = <div className="pose-editor pose-gallery" hidden={page !== 'gallery'}>
    <header className="pose-gallery-header">
      <div>
        <h2>Pose library</h2>
        <p>Pick a photo to edit its captions, timing, and who it is for.</p>
      </div>
      <span>{visibleCatalog.length}/{catalog.length}</span>
    </header>
    <div className="pose-library-filters">
      <input aria-label="Search poses" value={librarySearch} onChange={event => setLibrarySearch(event.target.value)} placeholder="Search poses" />
      <select aria-label="Pose category" value={libraryCategory} onChange={event => setLibraryCategory(event.target.value)}><option value="all">All categories</option>{libraryCategories.map(category => <option key={category} value={category}>{category}</option>)}</select>
      <button disabled={busy} onClick={() => openScene(blankPose())}>New</button>
      <button disabled={busy} onClick={() => void syncAllCaptions()}>Sync all captions</button>
      {syncingAll && <button onClick={() => { cancelSync.current = true; }}>Stop after current pose</button>}
    </div>
    {message ? <p className="pose-editor-message" role="status">{message}</p> : null}
    {visibleCatalog.length ? <div className="pose-library-list">{visibleCatalog.map(scene => <PoseGalleryCard key={scene.id} scene={scene} onOpen={() => { if (!busy) openScene(scene); }} />)}</div> : <p className="pose-gallery-empty">No poses match this filter.</p>}
  </div>;

  return <>
    {gallery}
    {page === 'detail' ? <div className="pose-editor">
    <button type="button" className="pose-back" onClick={backToGallery}>Back</button>
    <header className="admin-card pose-editor-header">
      <div className="pose-editor-heading">
        <div><h2>{draft.name}</h2><p>Edit this guide, then save it. Guests see the photo, captions, and narration.</p></div>
        <span className={`pose-editor-status${dirty ? ' unsaved' : ''}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
      </div>
      <div className="pose-editor-actions pose-editor-toolbar">
        <button onClick={() => openScene(blankPose())}>New</button>
        <button onClick={() => apply(scene => ({ ...scene, id: newId(), name: `${scene.name} (copy)` }))}>Duplicate</button>
        <button className="primary" disabled={busy} onClick={save}>Save pose</button>
        <span className="pose-toolbar-divider" />
        <button disabled={!past.length} onClick={() => { stopPreview(); setFuture(history => [cloneScene(draft), ...history]); setDraft(past.at(-1)!); setPast(past.slice(0, -1)); }}>Undo</button>
        <button disabled={!future.length} onClick={() => { stopPreview(); setPast([...past, cloneScene(draft)]); setDraft(future[0]); setFuture(future.slice(1)); }}>Redo</button>
        <button onClick={() => { stopPreview(); setDraft(cloneScene(saved)); setTime(0); setPast([]); setFuture([]); }}>Reset</button>
        <button aria-label="Export JSON" onClick={() => void write(() => window.photoBooth.exportPose(draft), 'JSON exported.')}>Export</button>
        <button className="danger" disabled={busy || bundled} onClick={() => { if (window.confirm(`Delete ${draft.name}?`)) void write(async () => { await window.photoBooth.deletePose(draft.id); const home = cloneScene(PHOTO_GUIDE_SCENES[0]); setDraft(home); setSaved(home); setTime(0); setPast([]); setFuture([]); setPage('gallery'); await refresh(); }, 'Pose deleted.'); }}>Delete</button>
      </div>
      {message ? <p className="pose-editor-message" role="status">{message}</p> : null}
    </header>

    <div className="pose-editor-grid pose-editor-detail">
      <main className="pose-editor-settings">
        <details className="admin-card pose-settings-card pose-ai-generator">
          <summary><span>AI Pose Generator</span><small>{aiProvider}</small></summary>
          <div className="pose-section-content">
            <label>Describe the pose<textarea aria-label="Pose description" className="pose-ai-description" rows={4} value={aiDescription} onChange={event => setAiDescription(event.target.value)} placeholder="Girl leaning slightly left, right hand making a peace sign beside her face, left hand on hip, right knee bent, head tilted right, big smile and left-eye wink." /></label>
            <div className="pose-ai-actions">
              <label>Provider<select aria-label="Pose AI provider" value={aiProvider} onChange={event => { const provider = event.target.value as typeof aiProvider; setAiProvider(provider); void updatePoseGenerator(provider); }}><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="xai">xAI</option></select></label>
              <button className="primary" disabled={busy || aiDescription.trim().length < 12} onClick={() => void generatePose()}>{busy ? 'Generating…' : 'Generate preview'}</button>
            </div>
            <p>{settings.ai.providers[aiProvider].apiKey ? 'API key ready.' : 'Add this provider’s API key in AI Presets before generating.'} Generated drafts stay local after you save them.</p>
            <details className="pose-nested-details"><summary>Provider settings</summary><div className="pose-ai-provider-settings"><TextField label="Model" value={settings.ai.poseGenerator.providers[aiProvider].model} onSave={value => { if (value !== settings.ai.poseGenerator.providers[aiProvider].model) void updatePoseGenerator(aiProvider, { model: value }); }} /><TextField label="API endpoint" value={settings.ai.poseGenerator.providers[aiProvider].apiUrl} onSave={value => { if (value !== settings.ai.poseGenerator.providers[aiProvider].apiUrl) void updatePoseGenerator(aiProvider, { apiUrl: value }); }} /></div></details>
          </div>
        </details>

        <section className="admin-card pose-settings-card">
          <div className="pose-section-title"><div><h3>Pose details</h3><p>Basic library information.</p></div></div>
          <div className="pose-compact-grid two-columns">
            <TextField label="Name" value={draft.name} onSave={value => { if (value !== draft.name) apply(scene => ({ ...scene, name: value })); }} />
            <TextField label="Category" value={draft.category} onSave={value => { if (value !== draft.category) apply(scene => ({ ...scene, category: value })); }} />
            <div className="span-all"><TextField label="Instruction" value={draft.instruction} onSave={value => { if (value !== draft.instruction) apply(scene => ({ ...scene, instruction: value })); }} /></div>
            <div className="span-all"><TextField label="Tags" value={draft.tags.join(', ')} onSave={value => { if (value !== draft.tags.join(', ')) apply(scene => ({ ...scene, tags: value.split(',').map(tag => tag.trim()).filter(Boolean) })); }} /></div>
          </div>
        </section>

        <details className="admin-card pose-settings-card">
          <summary><span>Group compatibility</span><small>{draft.compatibility.minPeople}–{draft.compatibility.maxPeople ?? '30'} people</small></summary>
          <div className="pose-section-content">
            <div className="pose-compact-grid two-columns"><NumberField label="Minimum people" value={draft.compatibility.minPeople} min={1} max={30} step={1} onSave={value => apply(scene => { scene.compatibility.minPeople = value; return scene; })} /><NumberField label="Maximum people (0 = flexible)" value={draft.compatibility.maxPeople ?? 0} min={0} max={30} step={1} onSave={value => apply(scene => { scene.compatibility.maxPeople = value === 0 ? null : value; return scene; })} /></div>
            <div className="pose-option-row">{(['solo', 'couple', 'friends', 'family', 'group'] as PoseStyle[]).map(style => <label key={style}><input type="checkbox" checked={draft.compatibility.styles.includes(style)} onChange={event => apply(scene => { scene.compatibility.styles = event.target.checked ? [...scene.compatibility.styles, style] : scene.compatibility.styles.filter(item => item !== style); return scene; })} />{style}</label>)}</div>
            <div className="pose-option-row">{(['full', 'half'] as const).map(mode => <label key={mode}><input type="checkbox" checked={draft.compatibility.framing.includes(mode)} onChange={event => apply(scene => { scene.compatibility.framing = event.target.checked ? [...scene.compatibility.framing, mode] : scene.compatibility.framing.filter(item => item !== mode); return scene; })} />{mode === 'full' ? 'Full body' : 'Half body'}</label>)}<label><input type="checkbox" checked={draft.compatibility.childSafe} onChange={event => apply(scene => { scene.compatibility.childSafe = event.target.checked; return scene; })} />Children</label></div>
          </div>
        </details>

        {photo && draft.visual ? <details className="admin-card pose-settings-card">
          <summary><span>Cutout</span><small>Artwork</small></summary>
          <div className="pose-section-content">
            <p>Replace the artwork and place it in the safe overlay.</p>
            <p className="pose-audio-path">{draft.visual.assetPath}</p>
            <div className="pose-editor-actions"><button aria-label="Replace cutout image" onClick={() => void write(async () => { const file = await window.photoBooth.importPoseImage(); if (file) apply(scene => scene.visual ? { ...scene, visual: { ...scene.visual, assetPath: file.filePath } } : scene); }, 'Cutout selected.')}>Replace image</button></div>
            <div className="pose-compact-grid two-columns">
              <TextField label="Description" value={draft.visual.alt} onSave={value => { if (draft.visual && value !== draft.visual.alt) apply(scene => scene.visual ? { ...scene, visual: { ...scene.visual, alt: value } } : scene); }} />
              <TextField label="Accent" value={draft.visual.accent} onSave={value => { if (draft.visual && value !== draft.visual.accent) apply(scene => scene.visual ? { ...scene, visual: { ...scene.visual, accent: value } } : scene); }} />
              <NumberField label="Scale" value={draft.visual.scale ?? 1} min={0.6} max={1.4} step={0.05} onSave={value => apply(scene => scene.visual ? { ...scene, visual: { ...scene.visual, scale: value } } : scene)} />
              <NumberField label="Offset X" value={draft.visual.offsetX ?? 0} min={-120} max={120} step={1} onSave={value => apply(scene => scene.visual ? { ...scene, visual: { ...scene.visual, offsetX: value } } : scene)} />
              <NumberField label="Offset Y" value={draft.visual.offsetY ?? 0} min={-80} max={80} step={1} onSave={value => apply(scene => scene.visual ? { ...scene, visual: { ...scene.visual, offsetY: value } } : scene)} />
            </div>
          </div>
        </details> : null}

        <details className="admin-card pose-settings-card">
          <summary><span>Guest roles</span><small>{draft.roles.length}</small></summary>
          <div className="pose-section-content">{draft.roles.map((role, index) => <div className="pose-caption-row" key={`${role.role}-${index}`}>
            <label>Role<select aria-label={`Guest role ${index + 1}`} value={role.role} onChange={event => apply(scene => { scene.roles[index].role = event.target.value as ParticipantRole; return scene; })}>{['any', 'adult', 'child', 'men', 'women', 'boys', 'girls'].map(option => <option key={option}>{option}</option>)}</select></label>
            <label><input type="checkbox" checked={role.repeatable} onChange={event => apply(scene => { scene.roles[index].repeatable = event.target.checked; return scene; })} />Repeat for larger groups</label>
            <button disabled={draft.roles.length === 1} onClick={() => apply(scene => { scene.roles.splice(index, 1); return scene; })}>Remove</button>
          </div>)}<button disabled={draft.roles.length >= 12} onClick={() => apply(scene => { scene.roles.push({ role: 'any', repeatable: false }); return scene; })}>Add role</button></div>
        </details>

        <details className="admin-card pose-settings-card">
          <summary><span>Narration</span><small>{draft.animation.captions.length} captions{draft.audio ? ` · ${(narration.durationMs / 1000).toFixed(1)}s` : ''}</small></summary>
          <div className="pose-section-content">
            <div className="pose-caption-list">{draft.animation.captions.map((caption, index) => <div className="pose-caption-row" key={`${caption.timeMs}-${index}`}>
              <strong className="pose-caption-number">{index + 1}</strong>
              <TextField label="Caption" value={caption.text} onSave={value => { if (value !== caption.text) apply(scene => { scene.animation.captions[index].text = value; return scene; }); }} />
              <button disabled={draft.animation.captions.length === 1} onClick={() => apply(scene => { scene.animation.captions.splice(index, 1); return fitSceneToNarration(scene, narration.durationMs); })}>Remove</button>
            </div>)}<button onClick={() => apply(scene => { scene.animation.captions.push({ timeMs: Math.max(1, scene.animation.durationMs - 1), text: 'New caption' }); return fitSceneToNarration(scene, narration.durationMs); })}>Add caption</button><p className="pose-timing-note">{hasMatchingSpeechTiming(draft) ? 'Captions follow the spoken phrases. The guide ends one second after narration.' : 'Captions are not speech-aligned yet. Generate narration or use Sync captions to match the recording.'}</p></div>
            <label className="pose-narration-script">Narration script<textarea rows={4} value={narrationScript} readOnly /></label>
            <div className="pose-editor-actions"><button onClick={() => setNarrationScript(captionScript(draft))}>Build script</button><button className="primary" disabled={busy || !narrationScript.trim()} onClick={() => void generateNarration()}>Generate MP3</button><button disabled={busy || !draft.audio} onClick={() => void syncCaptions()}>Sync captions</button><button disabled={!draft.audio || !narration.dataUrl} onClick={() => void playNarration()}>Play</button><button disabled={!draft.audio} onClick={() => stopAudioCue(CUE)}>Stop</button></div>
            {narrationMessage ? <p className="pose-narration-status" role="status">{narrationMessage}</p> : null}
            <p className="pose-audio-path">{draft.audio?.filePath ?? 'No narration assigned'}</p><div className="pose-editor-actions"><button aria-label="Assign audio file" onClick={() => void write(async () => { const file = await window.photoBooth.importPoseAudio(); if (file) { const audio = await readNarration(file.filePath); apply(scene => fitSceneToNarration({ ...scene, audio: { filePath: file.filePath, startMs: 0, markers: [] } }, audio.durationMs)); setNarration(audio); } }, 'Narration selected. Pose timing and captions were set automatically.')}>Assign audio</button><button disabled={!draft.audio} onClick={() => apply(scene => { delete scene.audio; scene.animation.captions.forEach(caption => { delete caption.markerId; delete caption.markerOffsetMs; }); return scene; })}>Remove audio</button></div>
            {draft.audio && narration.durationMs ? <p className="pose-timing-note">{(narration.durationMs / 1000).toFixed(1)}s narration · {(draft.animation.durationMs / 1000).toFixed(1)}s guide, including a 1 second final hold.</p> : null}
          </div>
        </details>

        <details className="admin-card pose-settings-card">
          <summary><span>Test guest group</span><small>{sceneMatches(draft, previewGroup, framing) ? 'Compatible' : 'Needs changes'}</small></summary>
          <div className="pose-section-content pose-composition-compact"><CompositionControls value={previewGroup} onChange={setPreviewGroup} capacity={30} /></div>
        </details>
      </main>

      <aside className="admin-card pose-editor-preview">
        <div className="pose-section-title"><div><h3>Cutout preview</h3><p>{(time / 1000).toFixed(2)} / {(draft.animation.durationMs / 1000).toFixed(2)}s</p></div><span className="pose-preview-live">Live</span></div>
        <div className="pose-editor-preview-visual" style={{ '--pose-scale': draft.visual?.scale ?? 1, '--pose-offset-x': `${draft.visual?.offsetX ?? 0}px`, '--pose-offset-y': `${draft.visual?.offsetY ?? 0}px` } as CSSProperties}>{photo && cutoutSrc ? <img className="pose-editor-cutout" src={cutoutSrc} alt={draft.visual?.alt ?? draft.name} /> : <p>Add a cutout image to preview this pose.</p>}{countdownPreview ? <strong className="pose-editor-countdown">{countdownPreview}</strong> : null}</div>
        <p className="pose-preview-caption">{caption}</p>
        <input aria-label="Animation position" type="range" min="0" max={draft.animation.durationMs} step="10" value={time} onInput={event => setClock(Number(event.currentTarget.value))} />
        <div className="pose-preview-buttons"><button className="primary" onClick={() => { player.current?.stop(); setPlaying(value => !value); }}>{playing ? 'Pause' : 'Play'}</button><button onClick={() => setClock(0)}>Restart</button><button disabled={busy} onClick={() => void completePreview()}>Play + countdown</button><button onClick={stopPreview}>Stop</button><button onClick={() => void window.photoBooth.previewPoseOnGuest({ scene: cloneScene(draft), framing }).then(() => setMessage('Opened on the guest screen.')).catch(error => setMessage(String(error)))}>Guest screen</button></div>
        <div className="pose-preview-options"><select aria-label="Preview framing" value={framing} onChange={event => setFraming(event.target.value as 'full' | 'half')}><option value="full">Full body</option><option value="half">Half body</option></select></div>
        <p className="pose-preview-hint">This is the offline guide guests will see. Captions and narration follow the timeline.</p>
      </aside>
    </div>
    </div> : null}
  </>;
}
