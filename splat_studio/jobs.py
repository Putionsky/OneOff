"""Single-job manager: runs the reconstruction in a worker thread and buffers
everything needed to replay the scene to WebSocket clients that connect at
any point (status, current-frame thumbnail, point chunks, camera poses)."""

from __future__ import annotations

import base64
import struct
import threading
from dataclasses import dataclass, field

import cv2
import numpy as np

from .pipeline import Callbacks, Config, VideoReconstructor

CHUNK_POINTS = 1
CHUNK_CAMERA = 2


def encode_points(xyz: np.ndarray, rgb: np.ndarray) -> bytes:
    n = len(xyz)
    return (struct.pack("<II", CHUNK_POINTS, n)
            + xyz.astype("<f4").tobytes()
            + rgb.astype(np.uint8).tobytes())


def encode_camera(T_wc: np.ndarray) -> bytes:
    return struct.pack("<II", CHUNK_CAMERA, 1) + T_wc.astype("<f4").tobytes()


@dataclass
class JobState:
    state: str = "idle"            # idle | processing | ready | error
    detail: str = ""
    progress: float = 0.0
    n_points: int = 0
    chunks: list = field(default_factory=list)      # binary WS frames, replayable
    frame_jpg_b64: str = ""
    frame_version: int = 0
    status_version: int = 0
    xyz: np.ndarray | None = None
    rgb: np.ndarray | None = None


class JobManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.job = JobState()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._generation = 0

    # ------------------------------------------------------------------ #

    def start(self, video_path: str):
        self.cancel()
        with self.lock:
            self._generation += 1
            gen = self._generation
            self.job = JobState(state="processing", detail="starting")
            self.job.status_version = 1
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._worker, args=(video_path, gen), daemon=True)
        self._thread.start()

    def cancel(self):
        if self._thread and self._thread.is_alive():
            self._stop.set()
            self._thread.join(timeout=30)
        self._thread = None

    # ------------------------------------------------------------------ #

    def _worker(self, video_path: str, gen: int):
        def stale() -> bool:
            return self._stop.is_set() or gen != self._generation

        def on_points(xyz, rgb):
            frame = encode_points(xyz, rgb)
            with self.lock:
                if gen != self._generation:
                    return
                self.job.chunks.append(frame)
                self.job.n_points += len(xyz)
                self.job.status_version += 1

        def on_camera(T_wc):
            frame = encode_camera(T_wc)
            with self.lock:
                if gen != self._generation:
                    return
                self.job.chunks.append(frame)

        def on_frame(bgr, idx, total):
            h, w = bgr.shape[:2]
            s = 320.0 / w
            thumb = cv2.resize(bgr, (320, int(h * s)))
            ok, jpg = cv2.imencode(".jpg", thumb, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if not ok:
                return
            with self.lock:
                if gen != self._generation:
                    return
                self.job.frame_jpg_b64 = base64.b64encode(jpg.tobytes()).decode("ascii")
                self.job.frame_version += 1

        def on_status(detail, progress):
            with self.lock:
                if gen != self._generation:
                    return
                self.job.detail = detail
                self.job.progress = progress
                self.job.status_version += 1

        cb = Callbacks(on_points=on_points, on_camera=on_camera,
                       on_frame=on_frame, on_status=on_status, should_stop=stale)
        try:
            result = VideoReconstructor(Config(), cb).run(video_path)
            with self.lock:
                if gen != self._generation:
                    return
                self.job.xyz = result.xyz
                self.job.rgb = result.rgb
                if self._stop.is_set():
                    self.job.state, self.job.detail = "ready", "stopped early"
                elif len(result.xyz) == 0:
                    self.job.state = "error"
                    self.job.detail = ("no structure recovered — the video needs "
                                       "camera motion with parallax")
                else:
                    self.job.state, self.job.detail = "ready", ""
                self.job.progress = 1.0
                self.job.status_version += 1
        except Exception as exc:  # surface pipeline failures to the UI
            with self.lock:
                if gen != self._generation:
                    return
                self.job.state, self.job.detail = "error", str(exc)
                self.job.status_version += 1

    # ------------------------------------------------------------------ #

    def snapshot_status(self) -> dict:
        with self.lock:
            j = self.job
            return {
                "type": "status", "state": j.state, "detail": j.detail,
                "progress": j.progress, "n_points": j.n_points,
                "version": j.status_version, "generation": self._generation,
            }

    def snapshot_frame(self) -> dict | None:
        with self.lock:
            if not self.job.frame_jpg_b64:
                return None
            return {"type": "frame", "jpg": self.job.frame_jpg_b64,
                    "version": self.job.frame_version}

    def chunks_since(self, cursor: int) -> tuple[list, int]:
        with self.lock:
            chunks = self.job.chunks[cursor:]
            return chunks, len(self.job.chunks)

    def scene(self):
        with self.lock:
            if self.job.state != "ready" or self.job.xyz is None:
                return None
            return self.job.xyz, self.job.rgb
