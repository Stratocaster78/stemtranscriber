from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from redis import Redis
from rq import Queue
import os
import uuid
import re
import json
from datetime import datetime, timezone
from pathlib import Path

app = FastAPI(title="StemTranscriber API")

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))

redis_conn = Redis.from_url(REDIS_URL)
q = Queue("default", connection=redis_conn)

def job_key(job_id: str) -> str:
    return f"stemtranscriber:job:{job_id}"

def project_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / project_id

def uploads_dir(project_id: str) -> Path:
    return project_dir(project_id) / "uploads"

def stems_dir(project_id: str) -> Path:
    return project_dir(project_id) / "stems"

def transcriptions_dir(project_id: str) -> Path:
    return project_dir(project_id) / "transcriptions"

def meta_path(project_id: str) -> Path:
    return project_dir(project_id) / "meta.json"

def read_meta(project_id: str) -> dict | None:
    p = meta_path(project_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None

def write_meta(project_id: str, meta: dict):
    meta_path(project_id).write_text(json.dumps(meta, ensure_ascii=False, indent=2))

class CreateProjectRequest(BaseModel):
    name: str | None = None

class ProjectItem(BaseModel):
    project_id: str
    name: str

class ListProjectsResponse(BaseModel):
    projects: list[ProjectItem]

class CreateProjectResponse(BaseModel):
    project_id: str
    name: str

class CreateJobResponse(BaseModel):
    job_id: str

class JobStatusResponse(BaseModel):
    job_id: str
    state: str
    progress: int
    message: str | None = None

class UploadResponse(BaseModel):
    filename: str

class StemItem(BaseModel):
    name: str
    url: str


class TranscribeRequest(BaseModel):
    stem_name: str = "bass.wav"
    instrument: str = "bass"   # bass | guitar

class TranscriptionItem(BaseModel):
    name: str
    url: str

@app.get("/health")
def health():
    return {"service": "stemtranscriber-api", "ok": True}

@app.get("/projects", response_model=ListProjectsResponse)
def list_projects():
    base = DATA_DIR / "projects"
    if not base.exists():
        return ListProjectsResponse(projects=[])

    items: list[ProjectItem] = []
    for d in sorted([x for x in base.iterdir() if x.is_dir()], key=lambda p: p.name):
        pid = d.name
        meta = read_meta(pid)
        name = (meta or {}).get("name") or pid
        items.append(ProjectItem(project_id=pid, name=name))

    return ListProjectsResponse(projects=items)

@app.post("/projects", response_model=CreateProjectResponse)
def create_project(body: CreateProjectRequest | None = None):
    project_id = str(uuid.uuid4())

    uploads_dir(project_id).mkdir(parents=True, exist_ok=True)
    stems_dir(project_id).mkdir(parents=True, exist_ok=True)

    name = (body.name.strip() if body and body.name else "") or f"Project {project_id[:8]}"
    meta = {
        "project_id": project_id,
        "name": name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    write_meta(project_id, meta)

    return CreateProjectResponse(project_id=project_id, name=name)

@app.post("/projects/{project_id}/upload", response_model=UploadResponse)
async def upload_audio(project_id: str, audio: UploadFile = File(...)):
    udir = uploads_dir(project_id)
    if not udir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    ext = Path(audio.filename).suffix or ".wav"
    out_path = udir / f"original{ext}"

    with out_path.open("wb") as f:
        f.write(await audio.read())

    return UploadResponse(filename=out_path.name)

@app.post("/projects/{project_id}/separate", response_model=CreateJobResponse)
def separate(project_id: str):
    udir = uploads_dir(project_id)
    if not udir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    originals = list(udir.glob("original.*"))
    if not originals:
        raise HTTPException(status_code=400, detail="No uploaded audio found")

    job_id = str(uuid.uuid4())
    redis_conn.hset(job_key(job_id), mapping={
        "state": "queued",
        "progress": 0,
        "message": "Separation queued",
        "project_id": project_id
    })

    q.enqueue(
        "tasks.separate_with_demucs",
        project_id,
        job_id,
        job_id=job_id,
        job_timeout=3600,
    )

    return CreateJobResponse(job_id=job_id)

@app.post("/projects/{project_id}/transcribe", response_model=CreateJobResponse)
def transcribe(project_id: str, body: TranscribeRequest):
    sdir = stems_dir(project_id)
    if not sdir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    stem_path = sdir / body.stem_name
    if not stem_path.exists():
        raise HTTPException(status_code=400, detail=f"Stem not found: {body.stem_name}")

    job_id = str(uuid.uuid4())
    redis_conn.hset(job_key(job_id), mapping={
        "state": "queued",
        "progress": 0,
        "message": f"Transcription queued ({body.stem_name})",
        "project_id": project_id
    })

    q.enqueue(
        "tasks.transcribe_monophonic",
        project_id,
        job_id,
        body.stem_name,
        body.instrument,
        job_id=job_id,
        job_timeout=3600,
    )
    return CreateJobResponse(job_id=job_id)

@app.get("/jobs/{job_id}", response_model=JobStatusResponse)
def get_job_status(job_id: str):
    data = redis_conn.hgetall(job_key(job_id))
    if not data:
        return JobStatusResponse(job_id=job_id, state="not_found", progress=0, message="Job not found")

    decoded = {k.decode(): v.decode() for k, v in data.items()}
    return JobStatusResponse(
        job_id=job_id,
        state=decoded.get("state", "unknown"),
        progress=int(decoded.get("progress", "0")),
        message=decoded.get("message"),
    )

@app.get("/projects/{project_id}/stems", response_model=list[StemItem])
def list_stems(project_id: str):
    sdir = stems_dir(project_id)
    if not sdir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    items: list[StemItem] = []
    for p in sorted(sdir.glob("*.wav")):
        items.append(StemItem(name=p.name, url=f"/files/{project_id}/stems/{p.name}"))
    return items

@app.get("/projects/{project_id}/transcriptions", response_model=list[TranscriptionItem])
def list_transcriptions(project_id: str):
    tdir = transcriptions_dir(project_id)
    if not tdir.exists():
        return []
    items: list[TranscriptionItem] = []
    for p in sorted(tdir.iterdir()):
        if p.is_file() and p.name.lower().endswith((".mid", ".midi", ".musicxml", ".xml")):
            items.append(TranscriptionItem(name=p.name, url=f"/files/{project_id}/transcriptions/{p.name}"))
    return items


@app.api_route("/files/{project_id}/transcriptions/{filename}", methods=["GET","HEAD"])
def get_transcription_file(project_id: str, filename: str):
    p = transcriptions_dir(project_id) / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail="File not found")
    media = "application/octet-stream"
    if filename.lower().endswith((".xml", ".musicxml")):
        media = "application/xml"
    return FileResponse(str(p), filename=filename, media_type=media, headers={"Cache-Control": "no-store"})

@app.api_route("/files/{project_id}/stems/{filename}", methods=["GET","HEAD"])
def get_stem_file(project_id: str, filename: str, request: Request):
    p = stems_dir(project_id) / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail="File not found")

    file_size = p.stat().st_size
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(str(p), filename=filename, media_type="audio/x-wav")

    m = re.match(r"bytes=(\d*)-(\d*)", range_header)
    if not m:
        return FileResponse(str(p), filename=filename, media_type="audio/x-wav")

    start_s, end_s = m.group(1), m.group(2)
    start = int(start_s) if start_s else 0
    end = int(end_s) if end_s else min(start + 1024 * 1024 - 1, file_size - 1)

    start = max(0, min(start, file_size - 1))
    end = max(start, min(end, file_size - 1))
    chunk_size = end - start + 1

    with p.open("rb") as f:
        f.seek(start)
        data = f.read(chunk_size)

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
        "Content-Disposition": f'inline; filename="{filename}"',
        "Cache-Control": "no-store",
    }

    return Response(content=data, status_code=206, media_type="audio/x-wav", headers=headers)
