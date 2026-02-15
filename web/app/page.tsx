"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

const AlphaTabViewer = dynamic(() => import("../components/AlphaTabViewer"), { ssr: false });

type Job = { job_id: string; state: string; progress: number; message?: string | null };
type ProjectItem = { project_id: string; name: string };
type ProjectList = { projects: ProjectItem[] };
type ProjectCreate = { project_id: string; name: string };
type Stem = { name: string; url: string };

async function safeJson(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
}

type TrackState = {
  name: string;
  url: string;
  buffer: AudioBuffer;        // original
  stretched?: AudioBuffer;    // tempo-adjusted (pitch-preserving)
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
};

export default function Page() {
  // Projects
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");

  // Separation
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string>("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string>("");

  // Stems list
  const [stems, setStems] = useState<Stem[]>([]);
  const [transcriptions, setTranscriptions] = useState<{ name: string; url: string }[]>([]);
  const [selectedMusicXmlUrl, setSelectedMusicXmlUrl] = useState<string>("");
  const [scoreTempo, setScoreTempo] = useState<number>(1.0);

  // Mixer state
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const trackGainRefs = useRef<Record<string, GainNode>>({});
  const trackPanRefs = useRef<Record<string, StereoPannerNode>>({});
  const sourcesRef = useRef<Record<string, AudioBufferSourceNode>>({});
  const rafRef = useRef<number | null>(null);

  const [tracks, setTracks] = useState<TrackState[] | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [masterGain, setMasterGain] = useState(1.0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // Time-stretch
  const [tempo, setTempo] = useState(1.0); // 0.2..1.0
  const [isRenderingTempo, setIsRenderingTempo] = useState(false);

  // Loop A/B
  const [loopOn, setLoopOn] = useState(false);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);

  const startedAtRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);

  const canSeparate = useMemo(() => !!projectId && !!file, [projectId, file]);

  function ensureAudio() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
      masterGainRef.current = audioCtxRef.current.createGain();
      masterGainRef.current.gain.value = masterGain;
      masterGainRef.current.connect(audioCtxRef.current.destination);
    }
  }

  function stopRaf() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  function stopSourcesOnly() {
    for (const k of Object.keys(sourcesRef.current)) {
      try { sourcesRef.current[k].stop(); } catch {}
    }
    sourcesRef.current = {};
  }

  function stopAll() {
    stopSourcesOnly();
    setIsPlaying(false);
    stopRaf();
    offsetRef.current = 0;
    setPosition(0);
  }

  function applyMixToNodes(nextTracks: TrackState[]) {
    const anySolo = nextTracks.some(t => t.solo);
    for (const t of nextTracks) {
      const g = trackGainRefs.current[t.name];
      const p = trackPanRefs.current[t.name];
      const audible = !t.mute && (!anySolo || t.solo);
      if (g) g.gain.value = audible ? t.gain : 0;
      if (p) p.pan.value = t.pan;
    }
  }

  function tickPosition() {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    const now = ctx.currentTime;
    const pos = offsetRef.current + (now - startedAtRef.current);
    const clamped = Math.min(pos, duration || pos);
    setPosition(clamped);

    // Loop handling
    if (loopOn && loopA != null && loopB != null && loopB > loopA && clamped >= loopB) {
      // hard restart at A
      seek(loopA);
      return;
    }

    rafRef.current = requestAnimationFrame(tickPosition);
  }

  async function refreshProjects() {
    setError("");
    try {
      const res = await fetch("/api/projects", { method: "GET" });
      if (!res.ok) throw new Error(`List projects failed: ${res.status}`);
      const data = (await safeJson(res)) as ProjectList | null;
      const list = data?.projects ?? [];
      setProjects(list);
      if (!projectId && list.length) setProjectId(list[list.length - 1].project_id);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    }
  }

  async function newProject() {
    setError("");
    setJobId("");
    setJob(null);
    setStems([]);
    setFile(null);
    setTracks(null);
    setIsPlaying(false);
    setPosition(0);
    setDuration(0);
    offsetRef.current = 0;
    setLoopOn(false);
    setLoopA(null);
    setLoopB(null);

    try {
      const payload = projectName.trim() ? JSON.stringify({ name: projectName.trim() }) : "";
      const res = await fetch("/api/projects", { method: "POST", body: payload });
      if (!res.ok) throw new Error(`Create project failed: ${res.status}`);
      const data = (await safeJson(res)) as ProjectCreate | null;
      if (!data?.project_id) throw new Error("Create project returned empty response");
      setProjectId(data.project_id);
      setProjectName("");
      await refreshProjects();
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    }
  }

  
  async function loadTranscriptions(pid: string) {
    setError("");
    setTranscriptions([]);
    if (!pid) return;

    const res = await fetch(`/api/projects/${pid}/transcriptions`, { cache: "no-store" });
    if (!res.ok) { setTranscriptions([]); return; }
    const data = (await safeJson(res)) as any[] | null;
    setTranscriptions((data ?? []).map((x) => ({ name: x.name, url: x.url })));
  }

  async function transcribe(pid: string, stem_name: string, instrument: string) {
    setError("");
    setJobId("");
    setJob(null);
    try {
      const res = await fetch(`/api/projects/${pid}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stem_name, instrument }),
      });
      if (!res.ok) throw new Error(`Transcribe failed: ${res.status}`);
      const data = (await safeJson(res)) as any;
      if (!data?.job_id) throw new Error("Transcribe returned empty response");
      setJobId(data.job_id);
    } catch (e: any) {
      setError(e?.message ?? "Transcription error");
    }
  }

async function loadStems(pid: string) {
    setError("");
    setStems([]);
    if (!pid) return;

    const res = await fetch(`/api/projects/${pid}/stems`, { cache: "no-store" });
    if (!res.ok) {
      setError(`No stems found for project ${pid} (or project missing).`);
      return;
    }
    const data = (await safeJson(res)) as Stem[] | null;
    setStems(data ?? []);
  }

  async function uploadAudio(pid: string, f: File) {
    const fd = new FormData();
    fd.append("audio", f);
    const res = await fetch(`/api/projects/${pid}/upload`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  }

  async function separate() {
    if (!projectId || !file) return;
    setError("");
    setJob(null);
    setStems([]);
    setTracks(null);
    setIsPlaying(false);
    setPosition(0);
    setDuration(0);
    offsetRef.current = 0;
    setLoopOn(false);
    setLoopA(null);
    setLoopB(null);

    try {
      await uploadAudio(projectId, file);
      const res = await fetch(`/api/projects/${projectId}/separate`, { method: "POST" });
      if (!res.ok) throw new Error(`Separate failed: ${res.status}`);
      const data = (await safeJson(res)) as any;
      if (!data?.job_id) throw new Error("Separate returned empty response");
      setJobId(data.job_id);
    } catch (e: any) {
      setError(e?.message ?? "Separation error");
    }
  }

  useEffect(() => {
    refreshProjects().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!jobId) return;

    let timer: any;
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Job status HTTP ${res.status}`);
        const data = (await safeJson(res)) as Job | null;
        if (!data) throw new Error("Empty job status response");
        setJob(data);

        if (["succeeded", "failed", "not_found"].includes(data.state)) {
          clearInterval(timer);
          if (data.state === "succeeded" && projectId) {
            await loadStems(projectId);
            await loadTranscriptions(projectId);
          }
        }
      } catch (e: any) {
        setError(e?.message ?? "Polling error");
      }
    };

    poll();
    timer = setInterval(poll, 900);
    return () => clearInterval(timer);
  }, [jobId, projectId]);

  // ---- Time-stretch helper (SoundTouch / WSOLA) ----
  async function stretchBufferPitchPreserving(ctx: AudioContext, input: AudioBuffer, tempoRatio: number): Promise<AudioBuffer> {
    // tempoRatio < 1 => slower (more samples)
    const stmod: any = await import("soundtouchjs");
    const { SoundTouch, SimpleFilter, WebAudioBufferSource } = stmod;

    const soundTouch = new SoundTouch(input.sampleRate);
    // soundtouch "tempo": 1.0 = normal; <1 slower; >1 faster
    soundTouch.tempo = tempoRatio;

    const source = new WebAudioBufferSource(input);
    const filter = new SimpleFilter(source, soundTouch);

    // Render in chunks
    const channels = input.numberOfChannels;
    const blockSize = 4096;
    const outL: number[] = [];
    const outR: number[] = [];
    const tmp = new Float32Array(blockSize * 2);

    // Pull samples until exhausted
    while (true) {
      const frames = filter.extract(tmp, blockSize);
      if (!frames || frames <= 0) break;

      if (channels === 1) {
        for (let i = 0; i < frames; i++) outL.push(tmp[i * 2]); // mono returned as interleaved
      } else {
        for (let i = 0; i < frames; i++) {
          outL.push(tmp[i * 2]);
          outR.push(tmp[i * 2 + 1]);
        }
      }
    }

    const outLen = outL.length;
    const out = ctx.createBuffer(channels, outLen, input.sampleRate);
    out.copyToChannel(Float32Array.from(outL), 0);
    if (channels > 1) out.copyToChannel(Float32Array.from(outR), 1);
    return out;
  }

  async function renderTempoForTracks(nextTempo: number) {
    if (!tracks) return;
    ensureAudio();
    const ctx = audioCtxRef.current!;

    setIsRenderingTempo(true);
    try {
      // stop playback while re-rendering
      const wasPlaying = isPlaying;
      const savedPos = position;
      stopAll();

      const updated: TrackState[] = [];
      for (const t of tracks) {
        const stretched = await stretchBufferPitchPreserving(ctx, t.buffer, nextTempo);
        updated.push({ ...t, stretched });
      }

      setTracks(updated);

      // duration in stretched domain (all should match-ish, but take max)
      const dur = updated.reduce((m, t) => Math.max(m, (t.stretched?.duration ?? t.buffer.duration)), 0);
      setDuration(dur);

      // restore position (scaled by tempo)
      // If you slow down (tempo 0.5), the new timeline is longer. Keep "musical position":
      const restored = savedPos / (tempo || 1);
      const newPos = Math.max(0, Math.min(restored, dur));
      setPosition(newPos);
      offsetRef.current = newPos;

      applyMixToNodes(updated);

      if (wasPlaying) startAll(offsetRef.current);
    } finally {
      setIsRenderingTempo(false);
    }
  }

  // Mixer: load stems into buffers + create nodes
  async function loadMixer() {
    if (!projectId) return;
    if (!stems.length) await loadStems(projectId);
            await loadTranscriptions(projectId);
    if (!stems.length) return;

    setError("");
    ensureAudio();
    const ctx = audioCtxRef.current!;
    const master = masterGainRef.current!;
    master.gain.value = masterGain;

    stopAll();

    const loaded: TrackState[] = [];
    for (const s of stems) {
      const url = `/api${s.url}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch ${s.name}: ${resp.status}`);
      const arr = await resp.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr.slice(0));
      loaded.push({ name: s.name, url: s.url, buffer: buf, gain: 1.0, pan: 0, mute: false, solo: false });
    }

    // nodes
    trackGainRefs.current = {};
    trackPanRefs.current = {};

    for (const t of loaded) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = t.pan;

      const gain = ctx.createGain();
      gain.gain.value = t.gain;

      pan.connect(gain);
      gain.connect(master);

      trackPanRefs.current[t.name] = pan;
      trackGainRefs.current[t.name] = gain;
    }

    // Render initial tempo-stretched buffers
    setIsRenderingTempo(true);
    const updated: TrackState[] = [];
    for (const t of loaded) {
      const stretched = await stretchBufferPitchPreserving(ctx, t.buffer, tempo);
      updated.push({ ...t, stretched });
    }
    setIsRenderingTempo(false);

    const dur = updated.reduce((m, t) => Math.max(m, (t.stretched?.duration ?? t.buffer.duration)), 0);
    setDuration(dur);
    setPosition(0);
    offsetRef.current = 0;
    setTracks(updated);
    applyMixToNodes(updated);
  }

  function startAll(fromSeconds: number) {
    ensureAudio();
    const ctx = audioCtxRef.current!;
    const master = masterGainRef.current!;
    master.gain.value = masterGain;

    if (!tracks) return;
    sourcesRef.current = {};

    for (const t of tracks) {
      const src = ctx.createBufferSource();
      src.buffer = t.stretched ?? t.buffer;
      src.connect(trackPanRefs.current[t.name]);
      sourcesRef.current[t.name] = src;
    }

    const now = ctx.currentTime;
    startedAtRef.current = now;
    offsetRef.current = fromSeconds;

    for (const name of Object.keys(sourcesRef.current)) {
      const src = sourcesRef.current[name];
      const off = Math.max(0, Math.min(fromSeconds, (src.buffer?.duration ?? fromSeconds)));
      src.start(0, off);
    }

    setIsPlaying(true);
    stopRaf();
    rafRef.current = requestAnimationFrame(tickPosition);
  }

  function pauseAll() {
    if (!isPlaying) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    const now = ctx.currentTime;
    const pos = offsetRef.current + (now - startedAtRef.current);
    stopSourcesOnly();
    offsetRef.current = pos;

    setIsPlaying(false);
    stopRaf();
    setPosition(Math.min(pos, duration || pos));
  }

  function seek(toSeconds: number) {
    const clamped = Math.max(0, Math.min(toSeconds, duration || toSeconds));
    setPosition(clamped);
    offsetRef.current = clamped;

    if (isPlaying) {
      stopSourcesOnly();
      startAll(clamped);
    } else {
      stopRaf();
    }
  }

  function updateTrack(name: string, patch: Partial<TrackState>) {
    if (!tracks) return;
    const next = tracks.map(t => t.name === name ? { ...t, ...patch } : t);
    setTracks(next);
    applyMixToNodes(next);
  }

  function toggleSolo(name: string) {
    if (!tracks) return;
    const next = tracks.map(t => t.name === name ? { ...t, solo: !t.solo } : t);
    setTracks(next);
    applyMixToNodes(next);
  }

  function toggleMute(name: string) {
    if (!tracks) return;
    const next = tracks.map(t => t.name === name ? { ...t, mute: !t.mute } : t);
    setTracks(next);
    applyMixToNodes(next);
  }

  function clearSolo() {
    if (!tracks) return;
    const next = tracks.map(t => ({ ...t, solo: false }));
    setTracks(next);
    applyMixToNodes(next);
  }

  useEffect(() => {
    if (!isPlaying) return;
    if (duration > 0 && position >= duration) stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, duration, isPlaying]);

  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = masterGain;
  }, [masterGain]);

  function fmt(s: number) {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  }

  function setLoopPointA() {
    setLoopA(position);
    if (loopB != null && loopB <= position) setLoopB(null);
  }
  function setLoopPointB() {
    setLoopB(position);
    if (loopA != null && position <= loopA) setLoopA(null);
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 28, maxWidth: 1120, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>StemTranscriber</h1>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        Mixer: pitch-preserving slow-down (20–100%) + loop A/B
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", minWidth: 320 }}
        />

        <button onClick={newProject} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
          New Project
        </button>

        <button onClick={refreshProjects} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
          Refresh projects
        </button>

        <select
          value={projectId}
          onChange={(e) => { setProjectId(e.target.value); setStems([]); setTracks(null); stopAll(); setLoopOn(false); setLoopA(null); setLoopB(null); }}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", minWidth: 380 }}
        >
          <option value="">Select a project…</option>
          {projects.map((p) => (
            <option key={p.project_id} value={p.project_id}>{p.name}</option>
          ))}
        </select>

        <button
          disabled={!projectId}
          onClick={() => loadStems(projectId)}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: projectId ? "pointer" : "not-allowed", opacity: projectId ? 1 : 0.5 }}
        >
          Load stems
        </button>

        <button
          disabled={!projectId}
          onClick={loadMixer}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: projectId ? "pointer" : "not-allowed", opacity: projectId ? 1 : 0.5 }}
        >
          Load into mixer
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
        <label style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
          Choose audio
          <input type="file" accept="audio/*" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>

        <button
          disabled={!canSeparate}
          onClick={separate}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: canSeparate ? "pointer" : "not-allowed", opacity: canSeparate ? 1 : 0.5 }}
        >
          Separate
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 14, padding: 10, border: "1px solid #f3c", borderRadius: 10 }}>
          <b>Error:</b> {error}
        </div>
      )}

      {jobId && (
        <div style={{ marginTop: 18, padding: 14, border: "1px solid #eee", borderRadius: 12 }}>
          <div><b>Job:</b> {jobId}</div>
          <div style={{ marginTop: 6 }}>
            <b>Status:</b> {job?.state ?? "…"}<br />
            <b>Progress:</b> {job?.progress ?? 0}%<br />
            <b>Message:</b> {job?.message ?? ""}
          </div>
          <div style={{ marginTop: 10, height: 10, background: "#eee", borderRadius: 999 }}>
            <div style={{ height: "100%", width: `${job?.progress ?? 0}%`, background: "#111", borderRadius: 999, transition: "width 200ms linear" }} />
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 24, marginBottom: 10 }}>Mixer</h2>

      {!tracks ? (
        <div style={{ opacity: 0.7 }}>Load stems, then click <b>Load into mixer</b>.</div>
      ) : (
        <div style={{ padding: 14, border: "1px solid #eee", borderRadius: 12 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              disabled={isRenderingTempo}
              onClick={() => (isPlaying ? pauseAll() : startAll(offsetRef.current))}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: isRenderingTempo ? "not-allowed" : "pointer", opacity: isRenderingTempo ? 0.6 : 1 }}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>

            <button
              onClick={stopAll}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Stop
            </button>

            <button
              onClick={clearSolo}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Clear Solo
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ minWidth: 70 }}><b>Master</b></span>
              <input type="range" min={0} max={1} step={0.01} value={masterGain} onChange={(e) => setMasterGain(parseFloat(e.target.value))} />
              <span style={{ width: 44, textAlign: "right" }}>{Math.round(masterGain * 100)}%</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ minWidth: 70 }}><b>Tempo</b></span>
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.01}
                value={tempo}
                disabled={isRenderingTempo}
                onChange={async (e) => {
                  const v = parseFloat(e.target.value);
                  setTempo(v);
                  await renderTempoForTracks(v);
                }}
              />
              <span style={{ width: 56, textAlign: "right" }}>{Math.round(tempo * 100)}%</span>
              {isRenderingTempo && <span style={{ opacity: 0.7 }}>rendering…</span>}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0)}
              step={0.01}
              value={position}
              onChange={(e) => seek(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.8 }}>
              <span>{fmt(position)}</span>
              <span>{fmt(duration)}</span>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={setLoopPointA} style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
              Set A
            </button>
            <button onClick={setLoopPointB} style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
              Set B
            </button>
            <button
              onClick={() => setLoopOn(v => !v)}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer", background: loopOn ? "#111" : "transparent", color: loopOn ? "#fff" : "#111" }}
              disabled={loopA == null || loopB == null || loopB <= loopA}
              title="Enable loop A→B"
            >
              Loop
            </button>
            <span style={{ opacity: 0.8 }}>
              A: {loopA == null ? "—" : fmt(loopA)} &nbsp; B: {loopB == null ? "—" : fmt(loopB)}
            </span>
          </div>

          <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
            {tracks.map((t) => (
              <div key={t.name} style={{ padding: 10, border: "1px solid #eee", borderRadius: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <b>{t.name}</b>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => toggleMute(t.name)}
                      style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer", background: t.mute ? "#111" : "transparent", color: t.mute ? "#fff" : "#111" }}
                    >
                      Mute
                    </button>
                    <button
                      onClick={() => toggleSolo(t.name)}
                      style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer", background: t.solo ? "#111" : "transparent", color: t.solo ? "#fff" : "#111" }}
                    >
                      Solo
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "110px 1fr 56px", gap: 10, alignItems: "center" }}>
                  <span><b>Vol</b></span>
                  <input type="range" min={0} max={1} step={0.01} value={t.gain} onChange={(e) => updateTrack(t.name, { gain: parseFloat(e.target.value) })} />
                  <span style={{ textAlign: "right" }}>{Math.round(t.gain * 100)}%</span>
                </div>

                <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "110px 1fr 56px", gap: 10, alignItems: "center" }}>
                  <span><b>Pan</b></span>
                  <input type="range" min={-1} max={1} step={0.01} value={t.pan} onChange={(e) => updateTrack(t.name, { pan: parseFloat(e.target.value) })} />
                  <span style={{ textAlign: "right" }}>{t.pan.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, marginBottom: 10 }} data-heading="h2">
      {selectedMusicXmlUrl ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <b>Score viewer</b>
            <button
              onClick={() => setSelectedMusicXmlUrl("")}
              style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
            >
              Close
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ minWidth: 90 }}><b>Score tempo</b></span>
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.01}
                value={scoreTempo}
                onChange={(e) => setScoreTempo(parseFloat(e.target.value))}
              />
              <span style={{ width: 56, textAlign: "right" }}>{Math.round(scoreTempo * 100)}%</span>
            </div>
          </div>

          <AlphaTabViewer musicXmlUrl={selectedMusicXmlUrl} tempo={scoreTempo} />
        </div>
      ) : null}

      {/* Transcription */}
      <h3 style={{ marginTop: 24, marginBottom: 10 }}>Transcription</h3>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          disabled={!projectId}
          onClick={() => transcribe(projectId, "bass.wav", "bass")}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: projectId ? "pointer" : "not-allowed", opacity: projectId ? 1 : 0.5 }}
        >
          Transcribe bass.wav
        </button>

        <button
          disabled={!projectId}
          onClick={() => transcribe(projectId, "other.wav", "guitar")}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: projectId ? "pointer" : "not-allowed", opacity: projectId ? 1 : 0.5 }}
        >
          Transcribe other.wav (guitar)
        </button>

        <button
          disabled={!projectId}
          onClick={() => loadTranscriptions(projectId)}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ccc", cursor: projectId ? "pointer" : "not-allowed", opacity: projectId ? 1 : 0.5 }}
        >
          Refresh transcriptions
        </button>
      </div>

      {transcriptions.length === 0 ? (
        <div style={{ marginTop: 10, opacity: 0.7 }}>No transcriptions yet.</div>
      ) : (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          {transcriptions.map((t) => {
            const href = `/api${t.url}`;
            return (
              <div key={t.name} style={{ padding: 12, border: "1px solid #eee", borderRadius: 12, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <b>{t.name}</b>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {(t.name.toLowerCase().endsWith(".musicxml") || t.name.toLowerCase().endsWith(".xml")) ? (
                    <button
                      onClick={() => setSelectedMusicXmlUrl(href)}
                      style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
                    >
                      Open score
                    </button>
                  ) : null}
                  <a href={href} download={t.name} style={{ textDecoration: "underline" }}>Download</a>
                </div>
              </div>
            );
          })}
        </div>
      )}


Stems (individual)</div>
      {stems.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No stems loaded.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {stems.map((s) => {
            const audioSrc = `/api${s.url}`;
            return (
              <div key={`${projectId}:${s.name}`} style={{ padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <b>{s.name}</b>
                  <a href={audioSrc} download={s.name} style={{ textDecoration: "underline" }}>Download</a>
                </div>
                <audio controls style={{ width: "100%", marginTop: 8 }}>
                  <source src={audioSrc} />
                </audio>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );

  function toggleSolo(name: string) {
    if (!tracks) return;
    const next = tracks.map(t => t.name === name ? { ...t, solo: !t.solo } : t);
    setTracks(next);
    applyMixToNodes(next);
  }

  function toggleMute(name: string) {
    if (!tracks) return;
    const next = tracks.map(t => t.name === name ? { ...t, mute: !t.mute } : t);
    setTracks(next);
    applyMixToNodes(next);
  }
}
