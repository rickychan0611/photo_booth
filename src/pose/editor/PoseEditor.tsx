import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AppSettings } from '../../types';
import { pauseAudioCue, playAudioCueObject, resumeAudioCue, seekAudioCue, stopAudioCue } from '../../audio';
import { resolvePoseAsset } from '../assets';
import { loadPhotoGuideCatalog } from '../repository';
import { BUNDLED_SCENES, PHOTO_GUIDE_SCENES, captionAt, sceneMatches } from '../scenes';
import { validateScene } from '../validation';
import { type GuestComposition, type ParticipantRole, type PoseScene, type PoseStyle } from '../types';
import { ScenePlayer } from '../ScenePlayer';
import { createPoseAudioHooks } from '../audio';
import { CompositionControls } from '../GuestCompositionScreen';
import { NumberField, TextField } from './Fields';
import { addStep, alignStep, cloneScene, deleteStep, moveMarker, moveStep, resizeScene } from './operations';
import { readNarration } from './narration';

const CUE = 'pose-editor-narration';
const newId = () => `custom-${crypto.randomUUID()}`;
export function PoseEditor({ settings }: { settings: AppSettings }) {
  const [catalog, setCatalog] = useState<PoseScene[]>(PHOTO_GUIDE_SCENES);
  const [draft, setDraft] = useState<PoseScene>(() => cloneScene(PHOTO_GUIDE_SCENES[0]));
  const [saved, setSaved] = useState<PoseScene>(() => cloneScene(PHOTO_GUIDE_SCENES[0]));
  const [past, setPast] = useState<PoseScene[]>([]), [future, setFuture] = useState<PoseScene[]>([]);
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [framing, setFraming] = useState<'full' | 'half'>('full');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [duration, setDuration] = useState(4), [stepTime, setStepTime] = useState(.5);
  const [librarySearch, setLibrarySearch] = useState(''), [libraryCategory, setLibraryCategory] = useState('all');
  const [narration, setNarration] = useState({ dataUrl: '', durationMs: 0 });
  const [previewGroup, setPreviewGroup] = useState<GuestComposition>({ men: 1, women: 0, boys: 0, girls: 0, style: 'solo' });
  const [countdownPreview, setCountdownPreview] = useState<number | null>(null);
  const [cutoutSrc, setCutoutSrc] = useState('');
  const [aiDescription, setAiDescription] = useState('');
  const [aiProvider, setAiProvider] = useState(settings.ai.poseGenerator.provider);
  const player = useRef<ScenePlayer | null>(null), countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const bundled = BUNDLED_SCENES.some(scene => scene.id === draft.id);
  const photo = draft.visual?.kind === 'photo-cutout';
  const libraryCategories = useMemo(() => [...new Set(catalog.map(scene => scene.category))].sort(), [catalog]);
  const visibleCatalog = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    return catalog.filter(scene => (libraryCategory === 'all' || scene.category === libraryCategory) && (!query || `${scene.name} ${scene.category} ${scene.tags.join(' ')} ${scene.instruction}`.toLowerCase().includes(query)));
  }, [catalog, libraryCategory, librarySearch]);
  const caption = captionAt(draft, time).caption;
  const times = [...new Set(draft.animation.captions.map(frame => frame.timeMs))].sort((a, b) => a - b);
  const refresh = async () => { const result = await loadPhotoGuideCatalog(); setCatalog(result.poses); if (result.errors.length) setMessage(result.errors.join('\n')); };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const assetPath = draft.visual?.assetPath;
    if (!assetPath) { setCutoutSrc(''); return; }
    let cancelled = false;
    void resolvePoseAsset(assetPath).then(src => { if (!cancelled) setCutoutSrc(src); });
    return () => { cancelled = true; };
  }, [draft.visual?.assetPath]);
  useEffect(() => { setAiProvider(settings.ai.poseGenerator.provider); }, [settings.ai.poseGenerator.provider]);
  useEffect(() => { setDuration(draft.animation.durationMs / 1000); setTime(value => Math.min(value, draft.animation.durationMs)); }, [draft.animation.durationMs]);
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
      let next = operation(cloneScene(draft));
      if (bundled) next = { ...next, id: newId(), name: `${next.name} (copy)` };
      validateScene(next);
      setPast(history => [...history.slice(-49), cloneScene(draft)]); setFuture([]); setDraft(next); setMessage('');
    } catch (error) { setMessage(String(error)); }
  }
  const select = (scene: PoseScene) => {
    if (dirty && !window.confirm('Discard unsaved pose changes?')) return;
    stopPreview(); stopAudioCue(CUE); setDraft(cloneScene(scene)); setSaved(cloneScene(scene)); setPast([]); setFuture([]); setTime(0); setMessage('');
  };
  const setClock = (next: number) => { stopPreview(); setTime(next); seekAudioCue(CUE, Math.max(0, next - (draft.audio?.startMs ?? 0)) / 1000); };
  useEffect(() => {
    if (!playing) return;
    let active = true, frame = 0, audioStarted = false, audioPending = false, lastRender = -100;
    const from = time >= draft.animation.durationMs ? 0 : time, began = performance.now();
    const tick = () => {
      if (!active) return;
      const next = Math.min(draft.animation.durationMs, from + performance.now() - began);
      if (narration.dataUrl && draft.audio && settings.audio.enabled && !audioStarted && !audioPending && next >= (draft.audio.startMs ?? 0)) {
        audioPending = true;
        void playAudioCueObject(settings, { id: CUE, label: draft.name, mode: 'mp3', channel: 'voice', text: '', filePath: draft.audio.filePath, enabled: true, loop: false, volume: 1, updatedAt: '' }, '', narration.dataUrl).then(async () => {
          if (!active) { pauseAudioCue(CUE); return; }
          seekAudioCue(CUE, Math.max(0, from + performance.now() - began - (draft.audio?.startMs ?? 0)) / 1000); await resumeAudioCue(CUE); audioStarted = true;
        }).catch(error => setMessage(String(error)));
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
    if (narration.durationMs && (scene.audio?.startMs ?? 0) + narration.durationMs > scene.animation.durationMs) throw new Error('Narration is longer than the animation. Fit to narration or extend the duration before saving.');
    if (bundled) scene = { ...scene, id: newId(), name: `${scene.name} (copy)` };
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
  return <div className="pose-editor">
    <header className="admin-card pose-editor-header">
      <div className="pose-editor-heading">
        <div><h2>Pose Challenges</h2><p>Preview the photo guides and edit timing, captions, compatibility, and narration.</p></div>
        <span className={`pose-editor-status${dirty ? ' unsaved' : ''}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
      </div>
      <div className="pose-editor-actions pose-editor-toolbar">
        <button onClick={() => { const base = cloneScene(PHOTO_GUIDE_SCENES[0]); select({ ...base, id: newId(), name: 'New pose', instruction: 'Hold the pose', roles: [{ role: 'any', repeatable: false }], compatibility: { minPeople: 1, maxPeople: 1, styles: ['solo'], framing: ['half'], childSafe: true }, animation: { durationMs: 4000, captions: [{ timeMs: 0, text: 'Find your mark' }, { timeMs: 2000, text: 'Hold the final pose' }] } }); }}>New</button>
        <button onClick={() => apply(scene => ({ ...scene, id: newId(), name: `${scene.name} (copy)` }))}>Duplicate</button>
        <button className="primary" disabled={busy} onClick={save}>Save pose</button>
        <span className="pose-toolbar-divider" />
        <button disabled={!past.length} onClick={() => { stopPreview(); setFuture(history => [cloneScene(draft), ...history]); setDraft(past.at(-1)!); setPast(past.slice(0, -1)); }}>Undo</button>
        <button disabled={!future.length} onClick={() => { stopPreview(); setPast([...past, cloneScene(draft)]); setDraft(future[0]); setFuture(future.slice(1)); }}>Redo</button>
        <button onClick={() => { stopPreview(); setDraft(cloneScene(saved)); setTime(0); setPast([]); setFuture([]); }}>Reset</button>
        <button aria-label="Export JSON" onClick={() => void write(() => window.photoBooth.exportPose(draft), 'JSON exported.')}>Export</button>
        <button className="danger" disabled={busy || bundled} onClick={() => { if (window.confirm(`Delete ${draft.name}?`)) void write(async () => { await window.photoBooth.deletePose(draft.id); setDraft(cloneScene(PHOTO_GUIDE_SCENES[0])); setSaved(cloneScene(PHOTO_GUIDE_SCENES[0])); setTime(0); setPast([]); setFuture([]); await refresh(); }, 'Pose deleted.'); }}>Delete</button>
      </div>
      {message ? <p className="pose-editor-message" role="status">{message}</p> : null}
    </header>

    <div className="pose-editor-grid">
      <aside className="admin-card pose-editor-library">
        <div className="pose-section-title"><h3>Pose library</h3><span>{visibleCatalog.length}/{catalog.length}</span></div>
        <div className="pose-library-filters"><input aria-label="Search poses" value={librarySearch} onChange={event => setLibrarySearch(event.target.value)} placeholder="Search poses" /><select aria-label="Pose category" value={libraryCategory} onChange={event => setLibraryCategory(event.target.value)}><option value="all">All categories</option>{libraryCategories.map(category => <option key={category} value={category}>{category}</option>)}</select></div>
        <div className="pose-library-list">{visibleCatalog.map(scene => <button key={scene.id} className={scene.id === draft.id ? 'active' : ''} onClick={() => select(scene)}><strong>{scene.name}</strong><small>{scene.category} · {scene.compatibility.minPeople}{scene.compatibility.maxPeople === null ? '+' : scene.compatibility.maxPeople > scene.compatibility.minPeople ? `–${scene.compatibility.maxPeople}` : ''}</small></button>)}</div>
      </aside>

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

        <section className="admin-card pose-settings-card">
          <div className="pose-section-title"><div><h3>Timeline</h3><p>Add and reposition teaching steps.</p></div><strong>{(draft.animation.durationMs / 1000).toFixed(1)}s</strong></div>
          <div className="pose-compact-grid timeline-grid">
            <NumberField label="Total seconds" value={duration} min={.1} max={120} onSave={setDuration} />
            <button onClick={() => apply(scene => resizeScene(scene, duration * 1000, false))}>Set duration</button>
            <button aria-label="Stretch animation" onClick={() => apply(scene => resizeScene(scene, duration * 1000, true))}>Stretch all</button>
            <label>Teaching frame<select aria-label="Teaching frame" value={times.includes(time) ? time : ''} onChange={event => setClock(Number(event.target.value))}><option value="" disabled>Scrubbing</option>{times.map(frameTime => <option key={frameTime} value={frameTime}>{(frameTime / 1000).toFixed(2)}s</option>)}</select></label>
            <NumberField label="Step seconds" value={stepTime} min={.01} max={120} onSave={setStepTime} />
            <button onClick={() => { apply(scene => addStep(scene, Math.round(stepTime * 1000))); setTime(Math.round(stepTime * 1000)); }}>Add step</button>
            <button disabled={time === 0} onClick={() => { apply(scene => moveStep(scene, time, Math.round(stepTime * 1000))); setTime(Math.round(stepTime * 1000)); }}>Move step</button>
            <button disabled={time === 0} onClick={() => apply(scene => deleteStep(scene, time))}>Delete step</button>
          </div>
        </section>

        <details className="admin-card pose-settings-card" open>
          <summary><span>Captions</span><small>{draft.animation.captions.length} cues</small></summary>
          <div className="pose-section-content pose-caption-list">{draft.animation.captions.map((caption, index) => <div className="pose-caption-row" key={`${caption.timeMs}-${index}`}>
            <NumberField label="At" value={caption.timeMs / 1000} min={0} max={120} onSave={value => apply(scene => { if (index === 0 && value !== 0) throw new Error('First caption starts at zero.'); scene.animation.captions[index] = { timeMs: Math.round(value * 1000), text: caption.text }; scene.animation.captions.sort((a, b) => a.timeMs - b.timeMs); return scene; })} />
            <TextField label="Caption" value={caption.text} onSave={value => { if (value !== caption.text) apply(scene => { scene.animation.captions[index].text = value; return scene; }); }} />
            <button disabled={index === 0} onClick={() => apply(scene => { scene.animation.captions.splice(index, 1); return scene; })}>Remove</button>
          </div>)}</div>
        </details>

        <details className="admin-card pose-settings-card">
          <summary><span>Group compatibility</span><small>{draft.compatibility.minPeople}–{draft.compatibility.maxPeople ?? '30'} people</small></summary>
          <div className="pose-section-content">
            <div className="pose-compact-grid two-columns"><NumberField label="Minimum people" value={draft.compatibility.minPeople} min={1} max={30} step={1} onSave={value => apply(scene => { scene.compatibility.minPeople = value; return scene; })} /><NumberField label="Maximum people (0 = flexible)" value={draft.compatibility.maxPeople ?? 0} min={0} max={30} step={1} onSave={value => apply(scene => { scene.compatibility.maxPeople = value === 0 ? null : value; return scene; })} /></div>
            <div className="pose-option-row">{(['solo', 'couple', 'friends', 'family', 'group'] as PoseStyle[]).map(style => <label key={style}><input type="checkbox" checked={draft.compatibility.styles.includes(style)} onChange={event => apply(scene => { scene.compatibility.styles = event.target.checked ? [...scene.compatibility.styles, style] : scene.compatibility.styles.filter(item => item !== style); return scene; })} />{style}</label>)}</div>
            <div className="pose-option-row">{(['full', 'half'] as const).map(mode => <label key={mode}><input type="checkbox" checked={draft.compatibility.framing.includes(mode)} onChange={event => apply(scene => { scene.compatibility.framing = event.target.checked ? [...scene.compatibility.framing, mode] : scene.compatibility.framing.filter(item => item !== mode); return scene; })} />{mode === 'full' ? 'Full body' : 'Half body'}</label>)}<label><input type="checkbox" checked={draft.compatibility.childSafe} onChange={event => apply(scene => { scene.compatibility.childSafe = event.target.checked; return scene; })} />Children</label></div>
          </div>
        </details>

        {photo && draft.visual ? <section className="admin-card pose-settings-card">
          <div className="pose-section-title"><div><h3>Cutout</h3><p>Replace the artwork and place it in the safe overlay.</p></div></div>
          <div className="pose-section-content">
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
        </section> : null}

        <details className="admin-card pose-settings-card">
          <summary><span>Guest roles</span><small>{draft.roles.length}</small></summary>
          <div className="pose-section-content">{draft.roles.map((role, index) => <div className="pose-caption-row" key={`${role.role}-${index}`}>
            <label>Role<select aria-label={`Guest role ${index + 1}`} value={role.role} onChange={event => apply(scene => { scene.roles[index].role = event.target.value as ParticipantRole; return scene; })}>{['any', 'adult', 'child', 'men', 'women', 'boys', 'girls'].map(option => <option key={option}>{option}</option>)}</select></label>
            <label><input type="checkbox" checked={role.repeatable} onChange={event => apply(scene => { scene.roles[index].repeatable = event.target.checked; return scene; })} />Repeat for larger groups</label>
            <button disabled={draft.roles.length === 1} onClick={() => apply(scene => { scene.roles.splice(index, 1); return scene; })}>Remove</button>
          </div>)}<button disabled={draft.roles.length >= 12} onClick={() => apply(scene => { scene.roles.push({ role: 'any', repeatable: false }); return scene; })}>Add role</button></div>
        </details>

        <details className="admin-card pose-settings-card">
          <summary><span>Narration</span><small>{draft.audio ? `${(narration.durationMs / 1000).toFixed(1)}s audio` : 'Optional'}</small></summary>
          <div className="pose-section-content"><p className="pose-audio-path">{draft.audio?.filePath ?? 'No narration assigned'}</p><div className="pose-editor-actions"><button aria-label="Assign audio file" onClick={() => void write(async () => { const file = await window.photoBooth.importPoseAudio(); if (file) apply(scene => ({ ...scene, audio: { filePath: file.filePath, startMs: 0, markers: [] } })); }, 'Narration selected.')}>Assign audio</button><button disabled={!draft.audio} onClick={() => apply(scene => { delete scene.audio; scene.animation.captions.forEach(caption => { delete caption.markerId; delete caption.markerOffsetMs; }); return scene; })}>Remove audio</button></div>
            {draft.audio ? <><div className="pose-compact-grid two-columns"><NumberField label="Audio starts at" value={(draft.audio.startMs ?? 0) / 1000} min={0} onSave={value => apply(scene => { scene.audio!.startMs = Math.round(value * 1000); return scene; })} /><button disabled={!narration.durationMs} onClick={() => apply(scene => resizeScene(scene, (scene.audio?.startMs ?? 0) + narration.durationMs, true))}>Fit animation to narration</button></div>{(draft.audio.markers ?? []).map((marker, index) => <div className="pose-marker-row" key={marker.id}><code>{marker.id}</code><NumberField label="At" value={marker.timeMs / 1000} min={0} onSave={value => apply(scene => moveMarker(scene, index, Math.round(value * 1000)))} /><button aria-label="Align current step" disabled={time === 0} onClick={() => { apply(scene => alignStep(scene, time, marker.id)); setTime(marker.timeMs); }}>Align step</button><button onClick={() => apply(scene => { scene.audio!.markers!.splice(index, 1); scene.animation.captions.forEach(caption => { if (caption.markerId === marker.id) { delete caption.markerId; delete caption.markerOffsetMs; } }); return scene; })}>Remove</button></div>)}<button onClick={() => apply(scene => { scene.audio!.markers = [...(scene.audio!.markers ?? []), { id: `marker-${crypto.randomUUID().slice(0, 8)}`, timeMs: time }].sort((a, b) => a.timeMs - b.timeMs); return scene; })}>Add marker at current time</button></> : null}
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
        <div className="pose-preview-buttons"><button className="primary" onClick={() => { player.current?.stop(); setPlaying(value => !value); }}>{playing ? 'Pause' : 'Play'}</button><button onClick={() => setClock(0)}>Restart</button><button disabled={busy} onClick={() => void completePreview()}>Play + countdown</button><button onClick={stopPreview}>Stop</button></div>
        <div className="pose-preview-options"><select aria-label="Preview framing" value={framing} onChange={event => setFraming(event.target.value as 'full' | 'half')}><option value="full">Full body</option><option value="half">Half body</option></select></div>
        <p className="pose-preview-hint">This is the offline guide guests will see. Captions and narration follow the timeline.</p>
      </aside>
    </div>
  </div>;
}
