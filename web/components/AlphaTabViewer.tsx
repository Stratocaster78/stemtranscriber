"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    alphaTab?: any;
  }
}

type Props = {
  musicXmlUrl: string; // /api/files/.../bass.musicxml
  tempo: number;       // 0.2..1.0
};

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.alphaTab) return resolve();

    const existing = document.querySelector(`script[data-at="alphatab"]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("alphaTab script load failed")));
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.at = "alphatab";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("alphaTab script load failed"));
    document.head.appendChild(s);
  });
}

export default function AlphaTabViewer({ musicXmlUrl, tempo }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);

  const [ready, setReady] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [err, setErr] = useState<string>("");
  const [debug, setDebug] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setErr("");
      setDebug("");
      setReady(false);
      setPlayerReady(false);

      if (!containerRef.current) return;
      containerRef.current.innerHTML = "";

      setDebug("Loading alphaTab script…");
      await loadScriptOnce("/alphatab/alphaTab.min.js");
      if (cancelled) return;

      const alphaTab = window.alphaTab;
      if (!alphaTab) throw new Error("window.alphaTab not available");

      setDebug("alphaTab loaded. Initializing…");

      const settings = new alphaTab.Settings();

      // Pitch fix: transpose track 0 up one octave (change to 24 if needed)
      settings.notation.transpositionPitches = [24];


      // resources
      settings.core.resourceUrl = new URL("/alphatab/", window.location.href).toString();

      // player
      settings.player.enablePlayer = true;
      settings.player.enableCursor = true;
      settings.player.scrollMode = alphaTab.ScrollMode.Continuous;

      // soundfont
      settings.player.soundFont = "/alphatab/soundfont/sonivox.sf2";

      // worklets can be flaky in some envs; start safe (classic)
      settings.player.enableAudioWorklets = false;

      const api = new alphaTab.AlphaTabApi(containerRef.current, settings);
      apiRef.current = api;

      api.error.on((e: any) => {
        console.error("alphaTab error", e);
        setErr(String(e?.message ?? e));
      });

      api.scoreLoaded.on(() => {
        if (cancelled) return;
        setReady(true);
        setDebug("Score loaded.");
        try { api.player.playbackSpeed = tempo; } catch {}
      });

      api.playerReady.on(() => {
        if (cancelled) return;
        setPlayerReady(true);
        setDebug("Player ready (soundfont loaded).");
      });

      api.playerStateChanged.on((s: any) => {
        if (cancelled) return;
        setDebug(`Player state: ${s}`);
      });

      setDebug(`Loading score: ${musicXmlUrl}`);
      api.load(musicXmlUrl);
    }

    init().catch((e) => {
      console.error(e);
      setErr(String((e as any)?.message ?? e));
    });

    return () => {
      cancelled = true;
      try { apiRef.current?.destroy?.(); } catch {}
      apiRef.current = null;
    };
  }, [musicXmlUrl]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    try { api.player.playbackSpeed = tempo; } catch {}
  }, [tempo]);

  const canPlay = ready && playerReady;

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <button
          onClick={() => apiRef.current?.player?.play()}
          disabled={!canPlay}
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: canPlay ? "pointer" : "not-allowed", opacity: canPlay ? 1 : 0.6 }}
        >
          Play
        </button>
        <button
          onClick={() => apiRef.current?.player?.pause()}
          disabled={!canPlay}
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: canPlay ? "pointer" : "not-allowed", opacity: canPlay ? 1 : 0.6 }}
        >
          Pause
        </button>
        <button
          onClick={() => apiRef.current?.player?.stop()}
          disabled={!canPlay}
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: canPlay ? "pointer" : "not-allowed", opacity: canPlay ? 1 : 0.6 }}
        >
          Stop
        </button>
        <span style={{ opacity: 0.7 }}>
          {canPlay ? "Ready" : ready ? "Loading player…" : "Loading score…"}
        </span>
      </div>

      {debug ? (
        <div style={{ marginBottom: 10, opacity: 0.7, fontFamily: "monospace" }}>{debug}</div>
      ) : null}

      {err ? (
        <div style={{ marginBottom: 10, padding: 10, borderRadius: 10, border: "1px solid #f2c2c2", background: "#fff5f5" }}>
          <b>alphaTab error:</b> {err}
        </div>
      ) : null}

      <style jsx global>{`
        .at-cursor-bar { background: rgba(255, 255, 0, 0.2); }
        .at-cursor-beat { background: rgba(0, 120, 255, 0.75); width: 3px; }
      `}</style>

      <div ref={containerRef} />
    </div>
  );
}
