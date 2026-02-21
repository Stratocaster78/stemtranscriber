"use client";

type Props = {
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
};

export default function TransportBar({ onPlay, onPause, onStop }: Props) {
  return (
    <div style={{ margin: "16px 0 22px 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ fontWeight: 700, marginRight: 8 }}>Global Transport</div>

      <button onClick={onPlay} style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
        ▶ Play
      </button>
      <button onClick={onPause} style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
        ⏸ Pause
      </button>
      <button onClick={onStop} style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}>
        ⏹ Stop
      </button>
    </div>
  );
}