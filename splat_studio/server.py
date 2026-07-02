"""FastAPI server: serves the viewer UI, accepts video uploads, streams the
growing reconstruction over a WebSocket, and exports the finished scene."""

from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import export
from .jobs import JobManager

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
WORKDIR = Path(tempfile.gettempdir()) / "splat_studio"
WORKDIR.mkdir(exist_ok=True)

app = FastAPI(title="OneOff Splat Studio")
jobs = JobManager()


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.post("/api/video")
async def upload_video(file: UploadFile):
    dest = WORKDIR / ("input" + Path(file.filename or "video.mp4").suffix)
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    await asyncio.to_thread(jobs.start, str(dest))
    return {"ok": True}


@app.websocket("/api/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    cursor = 0
    status_ver = -1
    frame_ver = -1
    generation = -1
    try:
        while True:
            status = jobs.snapshot_status()
            if status["generation"] != generation:
                generation = status["generation"]
                cursor = 0
                status_ver = frame_ver = -1
                await sock.send_json({"type": "reset"})
            if status["version"] != status_ver:
                status_ver = status["version"]
                await sock.send_json(status)
            frame = jobs.snapshot_frame()
            if frame and frame["version"] != frame_ver:
                frame_ver = frame["version"]
                await sock.send_json(frame)
            chunks, cursor = jobs.chunks_since(cursor)
            for c in chunks:
                await sock.send_bytes(c)
            await asyncio.sleep(0.05)
    except (WebSocketDisconnect, RuntimeError):
        pass


def _export(kind: str):
    scene = jobs.scene()
    if scene is None:
        return JSONResponse({"error": "scene not ready"}, status_code=409)
    xyz, rgb = export.clean_outliers(*scene)
    if kind == "pointcloud":
        body, name = export.pointcloud_ply(xyz, rgb), "pointcloud.ply"
    elif kind == "splat_ply":
        body, name = export.gaussian_ply(xyz, rgb), "scene_3dgs.ply"
    else:
        body, name = export.splat_binary(xyz, rgb), "scene.splat"
    out = WORKDIR / name
    out.write_bytes(body)  # also kept on disk for "Show in Finder"
    return Response(body, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/export/pointcloud.ply")
async def export_pointcloud():
    return await asyncio.to_thread(_export, "pointcloud")


@app.get("/api/export/scene_3dgs.ply")
async def export_gaussian_ply():
    return await asyncio.to_thread(_export, "splat_ply")


@app.get("/api/export/scene.splat")
async def export_splat():
    return await asyncio.to_thread(_export, "splat")


@app.post("/api/reveal")
async def reveal():
    opener = {"darwin": "open", "win32": "explorer"}.get(sys.platform, "xdg-open")
    try:
        subprocess.Popen([opener, str(WORKDIR)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass
    return {"path": str(WORKDIR)}
