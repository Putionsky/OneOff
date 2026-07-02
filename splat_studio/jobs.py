"""Single-job manager: runs the reconstruction in a worker thread and buffers
everything needed to replay the scene to WebSocket clients that connect at
any point (status, current-frame thumbnail, point chunks, camera poses)."""

from __future__ import annotations

import base64
import struct
import threading
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from scipy.spatial import cKDTree

from . import gsply, sharp_engine
from .pipeline import Callbacks, Config, VideoReconstructor

CHUNK_POINTS = 1        # legacy: xyz + rgb
CHUNK_CAMERA = 2
CHUNK_SPLATS = 3        # xyz + rgb + per-point radius


class RadiusEstimator:
    """Per-point splat radius from the local spacing in the accumulated cloud.

    Chunks arrive incrementally and differ wildly in density (sparse tracking
    landmarks vs. dense triangulated grids), so spacing is measured against a
    rolling window of recent points rather than within the chunk alone, and
    clamped against the running median so isolated outliers stay small.
    """

    def __init__(self, k: int = 3, window: int = 90_000):
        self.k = k
        self.window = window
        self._recent: list[np.ndarray] = []
        self._n_recent = 0
        self._median: float | None = None

    def reset(self):
        self._recent.clear()
        self._n_recent = 0
        self._median = None

    def radii(self, xyz: np.ndarray) -> np.ndarray:
        pool = np.vstack(self._recent + [xyz]) if self._recent else xyz
        if len(pool) <= self.k:
            r = np.full(len(xyz), 0.01, np.float32)
        else:
            d, _ = cKDTree(pool).query(xyz, k=self.k + 1, workers=-1)
            r = (d[:, 1:].mean(axis=1) * 0.7).astype(np.float32)
        med = float(np.median(r)) if len(r) else 0.01
        if self._median is None:
            self._median = med
        else:
            self._median = 0.9 * self._median + 0.1 * med
        r = np.clip(r, 1e-6, 3.0 * self._median).astype(np.float32)

        self._recent.append(xyz)
        self._n_recent += len(xyz)
        while self._n_recent > self.window and len(self._recent) > 1:
            self._n_recent -= len(self._recent.pop(0))
        return r


def encode_points(xyz: np.ndarray, rgb: np.ndarray, radii: np.ndarray) -> bytes:
    n = len(xyz)
    return (struct.pack("<II", CHUNK_SPLATS, n)
            + xyz.astype("<f4").tobytes()
            + rgb.astype(np.uint8).tobytes()
            + radii.astype("<f4").tobytes())


def encode_camera(T_wc: np.ndarray) -> bytes:
    return struct.pack("<II", CHUNK_CAMERA, 1) + T_wc.astype("<f4").tobytes()


@dataclass
class JobState:
    state: str = "idle"            # idle | processing | ready | error
    engine: str = "sfm"            # sfm (video) | sharp (photo)
    detail: str = ""
    progress: float = 0.0
    n_points: int = 0
    chunks: list = field(default_factory=list)      # binary WS frames, replayable
    frame_jpg_b64: str = ""
    frame_version: int = 0
    status_version: int = 0
    xyz: np.ndarray | None = None
    rgb: np.ndarray | None = None
    gaussians: gsply.GaussianScene | None = None    # full attrs (sharp engine)
    raw_gs_ply: bytes | None = None                 # untouched SHARP output


class JobManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.job = JobState()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._generation = 0

    # ------------------------------------------------------------------ #

    def start(self, media_path: str):
        self.cancel()
        is_image = Path(media_path).suffix.lower() in sharp_engine.IMAGE_EXTS
        engine = "sharp" if is_image else "sfm"
        with self.lock:
            self._generation += 1
            gen = self._generation
            self.job = JobState(state="processing", detail="starting", engine=engine)
            self.job.status_version = 1
        self._stop.clear()
        target = self._worker_sharp if is_image else self._worker
        self._thread = threading.Thread(target=target, args=(media_path, gen), daemon=True)
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

        radius_est = RadiusEstimator()

        def on_points(xyz, rgb):
            frame = encode_points(xyz, rgb, radius_est.radii(xyz))
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

    def _worker_sharp(self, image_path: str, gen: int):
        """Photo -> gaussians through the SHARP CLI adapter."""

        def set_status(state=None, detail=None, progress=None):
            with self.lock:
                if gen != self._generation:
                    return
                if state:
                    self.job.state = state
                if detail is not None:
                    self.job.detail = detail
                if progress is not None:
                    self.job.progress = progress
                self.job.status_version += 1

        try:
            img = cv2.imread(image_path)
            if img is None:
                raise RuntimeError(f"cannot read image: {image_path}")
            h, w = img.shape[:2]
            thumb = cv2.resize(img, (320, max(1, int(h * 320.0 / w))))
            ok, jpg = cv2.imencode(".jpg", thumb, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if ok:
                with self.lock:
                    if gen != self._generation:
                        return
                    self.job.frame_jpg_b64 = base64.b64encode(jpg.tobytes()).decode("ascii")
                    self.job.frame_version += 1

            if not sharp_engine.available():
                raise RuntimeError(sharp_engine.install_hint())

            set_status(detail="running SHARP", progress=0.15)
            out_dir = Path(image_path).parent / "sharp_out"
            ply_path = sharp_engine.run(image_path, out_dir)

            set_status(detail="loading gaussians", progress=0.8)
            raw = ply_path.read_bytes()
            scene = gsply.read(raw)

            # stream to the viewer as disc splats; drop near-invisible ones
            visible = scene.opacity > 0.05
            xyz, rgb = scene.xyz[visible], scene.rgb[visible]
            radii = np.clip(
                np.cbrt(np.prod(scene.scales[visible], axis=1)),  # geometric mean
                1e-6, np.percentile(scene.scales[visible], 97))
            for i in range(0, len(xyz), 100_000):
                if gen != self._generation:
                    return
                sl = slice(i, i + 100_000)
                frame = encode_points(xyz[sl], rgb[sl], radii[sl].astype(np.float32))
                with self.lock:
                    if gen != self._generation:
                        return
                    self.job.chunks.append(frame)
                    self.job.n_points += len(xyz[sl])
                    self.job.status_version += 1

            with self.lock:
                if gen != self._generation:
                    return
                self.job.xyz, self.job.rgb = xyz, rgb
                self.job.gaussians = scene
                self.job.raw_gs_ply = raw
            set_status(state="ready", detail="", progress=1.0)
        except Exception as exc:
            set_status(state="error", detail=str(exc))

    # ------------------------------------------------------------------ #

    def snapshot_status(self) -> dict:
        with self.lock:
            j = self.job
            return {
                "type": "status", "state": j.state, "detail": j.detail,
                "progress": j.progress, "n_points": j.n_points,
                "version": j.status_version, "generation": self._generation,
                "engine": j.engine,
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

    def export_data(self) -> dict | None:
        with self.lock:
            j = self.job
            if j.state != "ready" or j.xyz is None:
                return None
            return {"engine": j.engine, "xyz": j.xyz, "rgb": j.rgb,
                    "gaussians": j.gaussians, "raw_gs_ply": j.raw_gs_ply}
