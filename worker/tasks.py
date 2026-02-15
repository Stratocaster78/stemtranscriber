import os
import re
import shutil
import subprocess
from pathlib import Path
from redis import Redis

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
redis_conn = Redis.from_url(REDIS_URL)

DEMUCS_MODEL = os.getenv("DEMUCS_MODEL", "htdemucs")

def job_key(job_id: str) -> str:
    return f"stemtranscriber:job:{job_id}"

def uploads_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / project_id / "uploads"

def stems_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / project_id / "stems"

def find_stem_folder(tmp_out: Path) -> Path | None:
    expected = {"bass.wav", "drums.wav", "other.wav", "vocals.wav"}
    candidates = []
    for p in tmp_out.rglob("bass.wav"):
        d = p.parent
        present = {x.name for x in d.glob("*.wav")}
        score = len(expected.intersection(present))
        candidates.append((score, d))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0], reverse=True)
    return candidates[0][1]

RE_TQDM_PCT = re.compile(r"^\s*(\d{1,3})%\|")  # lines like " 65%|████..."
RE_TQDM_FRAC = re.compile(r"(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)")  # fallback "152.1/234.0"

def clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))

def set_progress(job_id: str, progress: int, message: str | None = None):
    mapping = {"state": "running", "progress": str(progress)}
    if message is not None:
        mapping["message"] = message
    redis_conn.hset(job_key(job_id), mapping=mapping)

def separate_with_demucs(project_id: str, job_id: str):
    set_progress(job_id, 1, "Preparing Demucs...")

    udir = uploads_dir(project_id)
    sdir = stems_dir(project_id)
    sdir.mkdir(parents=True, exist_ok=True)

    originals = list(udir.glob("original.*"))
    if not originals:
        redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": "No uploaded audio"})
        return
    src = originals[0]

    tmp_out = DATA_DIR / "tmp_demucs" / project_id / job_id
    if tmp_out.exists():
        shutil.rmtree(tmp_out, ignore_errors=True)
    tmp_out.mkdir(parents=True, exist_ok=True)

    # map demucs progress into 5..85
    set_progress(job_id, 5, f"Running Demucs ({DEMUCS_MODEL})...")

    cmd = ["demucs", "-n", DEMUCS_MODEL, "--out", str(tmp_out), str(src)]
    print("Running:", " ".join(cmd), flush=True)

    last_scaled = -1
    rc = 1

    try:
        # NOTE: demucs tqdm sometimes writes to stderr; we redirect stderr->stdout
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        assert proc.stdout is not None

        for raw in proc.stdout:
            line = raw.rstrip("\n")
            print(line, flush=True)

            pct = None
            m = RE_TQDM_PCT.match(line)
            if m:
                pct = int(m.group(1))
            else:
                mf = RE_TQDM_FRAC.search(line)
                if mf:
                    x = float(mf.group(1))
                    total = float(mf.group(2))
                    if total > 0:
                        pct = int((x / total) * 100)

            if pct is not None:
                pct = clamp(pct, 0, 100)
                scaled = 5 + int((pct / 100) * 80)  # 5..85
                if scaled != last_scaled:
                    last_scaled = scaled
                    set_progress(job_id, scaled, f"Separating… {pct}%")

        rc = proc.wait()

    except Exception as e:
        redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": f"Demucs exception: {e}"})
        return

    if rc != 0:
        redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": "Demucs failed. Check worker logs."})
        return

    set_progress(job_id, 90, "Collecting stems...")

    stem_folder = find_stem_folder(tmp_out)
    if not stem_folder:
        print("No demucs output found. tmp_out tree (top 4 levels):", flush=True)
        for p in tmp_out.rglob("*"):
            rel = p.relative_to(tmp_out)
            if len(rel.parts) <= 4:
                print(" -", rel, flush=True)
        redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": "No demucs output found"})
        return

    expected = ["bass.wav", "drums.wav", "other.wav", "vocals.wav"]
    copied = 0
    for name in expected:
        src_stem = stem_folder / name
        if src_stem.exists():
            shutil.copyfile(src_stem, sdir / name)
            copied += 1

    if copied == 0:
        redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": "No stems copied"})
        return

    shutil.rmtree(tmp_out, ignore_errors=True)
    redis_conn.hset(job_key(job_id), mapping={"state": "succeeded", "progress": "100", "message": "Stems ready (Demucs)."})


# ---------------------------
# Transcription (monophonic)
# ---------------------------
import numpy as np

def transcriptions_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / project_id / "transcriptions"

def hz_to_midi(hz: float) -> int:
    return int(round(69 + 12 * np.log2(hz / 440.0)))

def transcribe_monophonic(project_id: str, job_id: str, stem_name: str = "bass.wav", instrument: str = "bass"):
    """
    MVP transcription:
    - Monophonic pitch tracking (librosa.pyin)
    - Group contiguous frames into notes
    - Export MIDI (pretty_midi)
    - Convert to MusicXML (music21)
    """
    try:
        set_progress(job_id, 1, "Preparing transcription...")

        sfile = stems_dir(project_id) / stem_name
        if not sfile.exists():
            redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": f"Stem not found: {stem_name}"})
            return

        out_dir = transcriptions_dir(project_id)
        out_dir.mkdir(parents=True, exist_ok=True)

        set_progress(job_id, 5, "Loading audio...")

        import librosa
        import pretty_midi
        import music21 as m21

        y, sr = librosa.load(str(sfile), sr=22050, mono=True)

        # Light denoise / trim silence
        y, _ = librosa.effects.trim(y, top_db=35)

        set_progress(job_id, 15, "Detecting pitch (pyin)...")

        # pyin: monophonic fundamental frequency estimation
        f0, voiced_flag, voiced_prob = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("E1") if instrument == "bass" else librosa.note_to_hz("E2"),
            fmax=librosa.note_to_hz("C5"),
            sr=sr,
            frame_length=2048,
            hop_length=256,
        )

        times = librosa.times_like(f0, sr=sr, hop_length=256)

        # Convert to MIDI notes per frame (NaN when unvoiced)
        midi_frame = np.full_like(f0, fill_value=-1, dtype=np.int32)
        for i, hz in enumerate(f0):
            if hz is not None and not np.isnan(hz):
                midi_frame[i] = hz_to_midi(float(hz))

        # Smooth: median filter-ish (reduce jitter)
        # simple: replace isolated spikes
        for i in range(2, len(midi_frame) - 2):
            window = midi_frame[i-2:i+3]
            vals = window[window >= 0]
            if len(vals) >= 3:
                median = int(np.median(vals))
                midi_frame[i] = median

        set_progress(job_id, 35, "Building notes...")

        # Group contiguous frames of same midi into notes
        notes = []
        i = 0
        min_note_len_s = 0.06  # discard tiny blips
        while i < len(midi_frame):
            if midi_frame[i] < 0:
                i += 1
                continue
            note = int(midi_frame[i])
            start_t = float(times[i])
            j = i + 1
            while j < len(midi_frame) and midi_frame[j] == note:
                j += 1
            end_t = float(times[j-1]) + (times[1] - times[0] if len(times) > 1 else 0.01)
            if end_t - start_t >= min_note_len_s:
                notes.append((note, start_t, end_t))
            i = j

        if not notes:
            redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": "No notes detected (try bass stem, or cleaner audio)."})
            return

        set_progress(job_id, 55, "Writing MIDI...")

        pm = pretty_midi.PrettyMIDI()
        program = pretty_midi.instrument_name_to_program("Electric Bass (finger)") if instrument == "bass" else pretty_midi.instrument_name_to_program("Electric Guitar (clean)")
        inst = pretty_midi.Instrument(program=program, name=instrument)

        for pitch, start, end in notes:
            inst.notes.append(pretty_midi.Note(velocity=90, pitch=int(pitch), start=float(start), end=float(end)))
        pm.instruments.append(inst)

        midi_path = out_dir / f"{stem_name.replace('.wav','')}.mid"
        pm.write(str(midi_path))

        set_progress(job_id, 75, "Converting to MusicXML...")

        # music21 conversion
        score = m21.converter.parse(str(midi_path))
        xml_path = out_dir / f"{stem_name.replace('.wav','')}.musicxml"
        score.write("musicxml", fp=str(xml_path))

        redis_conn.hset(job_key(job_id), mapping={"state": "succeeded", "progress": "100", "message": "Transcription ready (MIDI + MusicXML)."})
        return

    except Exception as e:
        redis_conn.hset(job_key(job_id), mapping={"state": "failed", "progress": "0", "message": f"Transcription exception: {e}"})
        raise
