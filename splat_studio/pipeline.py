"""Incremental monocular structure-from-motion over a video.

Tracks corners with pyramidal Lucas-Kanade optical flow, bootstraps the map
with an essential-matrix pose between the first two keyframes, localizes the
following keyframes with PnP on the triangulated landmarks, and triangulates
new landmarks between consecutive keyframes. Coordinates follow the OpenCV
camera convention of the first frame: +X right, +Y down, +Z forward.

The reconstruction is streamed incrementally through callbacks so a viewer
can display the scene while the video is still being processed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Optional

import cv2
import numpy as np


@dataclass
class Callbacks:
    """Hooks invoked from the processing thread as the scene grows."""

    on_points: Callable[[np.ndarray, np.ndarray], None] = lambda xyz, rgb: None
    on_camera: Callable[[np.ndarray], None] = lambda T_wc: None
    on_frame: Callable[[np.ndarray, int, int], None] = lambda bgr, idx, total: None
    on_status: Callable[[str, float], None] = lambda detail, progress: None
    should_stop: Callable[[], bool] = lambda: False


@dataclass
class Config:
    max_width: int = 960          # frames are downscaled to at most this width
    fov_deg: float = 62.0         # assumed horizontal field of view
    max_tracks: int = 2400        # corner budget per frame
    grid_cell: int = 24           # min pixel spacing between tracked corners
    kf_flow_frac: float = 0.035   # median flow (fraction of width) that triggers a keyframe
    kf_min_tracks_frac: float = 0.55  # keyframe when this fraction of tracks survives
    lk_win: int = 21
    fb_max_err: float = 1.2       # forward-backward tracking consistency (px)
    min_parallax_deg: float = 0.6
    max_reproj_err: float = 2.0   # px
    frame_stride: int = 1
    max_points_per_kf: int = 4000
    thumb_every_n_frames: int = 6
    # dense triangulation between keyframes, once the pose is known
    densify: bool = True
    densify_stride: int = 3           # sample one candidate pixel every N px
    densify_grad_thresh: float = 18.0  # minimum Sobel magnitude to be a candidate
    densify_max_per_kf: int = 14000
    densify_max_reproj: float = 1.5   # px, tighter than the sparse map
    max_total_points: int = 1_500_000


@dataclass
class Track:
    """A corner followed across frames until it is triangulated or lost."""

    pt: np.ndarray                # current 2D position (2,)
    kf_pt: np.ndarray             # position at the last keyframe (2,)
    landmark: int = -1            # index into the map, -1 while untriangulated


@dataclass
class Result:
    xyz: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), np.float32))
    rgb: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), np.uint8))
    cameras: list = field(default_factory=list)   # 4x4 T_wc per keyframe
    n_frames: int = 0
    n_keyframes: int = 0


class VideoReconstructor:
    def __init__(self, config: Config | None = None, callbacks: Callbacks | None = None):
        self.cfg = config or Config()
        self.cb = callbacks or Callbacks()

    # ------------------------------------------------------------------ #

    def run(self, video_path: str) -> Result:
        cfg, cb = self.cfg, self.cb
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open video: {video_path}")
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

        result = Result()
        tracks: list[Track] = []
        landmarks: list[np.ndarray] = []       # world 3D points, one per landmark
        prev_gray: Optional[np.ndarray] = None
        kf_gray: Optional[np.ndarray] = None   # grayscale of the last keyframe
        kf_pose: Optional[np.ndarray] = None   # 3x4 [R|t] world-to-camera of last keyframe
        initialized = False
        scale = 1.0
        K = None
        frame_idx = -1
        n_tracks_at_kf = 0

        while True:
            if cb.should_stop():
                break
            for _ in range(cfg.frame_stride):
                ok, frame = cap.read()
                frame_idx += 1
                if not ok:
                    break
            if not ok:
                break

            if K is None:
                h, w = frame.shape[:2]
                scale = min(1.0, cfg.max_width / w)
                K = self._intrinsics(int(w * scale), int(h * scale))
            if scale < 1.0:
                frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            result.n_frames += 1

            if frame_idx % cfg.thumb_every_n_frames == 0:
                cb.on_frame(frame, frame_idx, total)
            progress = frame_idx / total if total else 0.0

            if kf_gray is None:
                # first frame becomes the first keyframe at the world origin
                kf_gray = gray
                kf_pose = np.hstack([np.eye(3), np.zeros((3, 1))]).astype(np.float64)
                tracks = self._detect(gray, tracks)
                n_tracks_at_kf = len(tracks)
                result.cameras.append(_to_Twc(kf_pose))
                result.n_keyframes = 1
                cb.on_camera(result.cameras[-1])
                cb.on_status("tracking", progress)
                prev_gray = gray
                continue

            tracks = self._flow(prev_gray, gray, tracks)
            prev_gray = gray
            if len(tracks) < 8:
                # tracking collapsed (e.g. hard cut): restart from this frame
                kf_gray = gray
                tracks = self._detect(gray, [])
                continue

            flow = np.median([np.linalg.norm(t.pt - t.kf_pt) for t in tracks])
            need_kf = flow > cfg.kf_flow_frac * gray.shape[1] or \
                len(tracks) < cfg.kf_min_tracks_frac * max(n_tracks_at_kf, 1)
            if not need_kf:
                continue

            # ---------------- keyframe ---------------- #
            if not initialized:
                pose = self._bootstrap(tracks, K, kf_pose, landmarks, frame, result)
                if pose is None:
                    cb.on_status("looking for parallax", progress)
                    # keep waiting for more baseline unless tracking is dying
                    if len(tracks) < 0.4 * max(n_tracks_at_kf, 1):
                        kf_gray = gray
                        for t in tracks:
                            t.kf_pt = t.pt.copy()
                        tracks = self._detect(gray, tracks)
                        n_tracks_at_kf = len(tracks)
                    continue
                initialized = True
            else:
                pose = self._localize(tracks, landmarks, K)
                if pose is None:
                    cb.on_status("relocalizing", progress)
                    kf_gray = gray
                    for t in tracks:
                        t.kf_pt = t.pt.copy()
                    tracks = self._detect(gray, tracks)
                    n_tracks_at_kf = len(tracks)
                    continue
                self._triangulate_new(tracks, K, kf_pose, pose, landmarks, frame, result)

            if cfg.densify:
                self._densify(kf_gray, gray, frame, K, kf_pose, pose, result)
            kf_pose = pose
            kf_gray = gray
            for t in tracks:
                t.kf_pt = t.pt.copy()
            tracks = self._detect(gray, tracks)
            n_tracks_at_kf = len(tracks)
            result.cameras.append(_to_Twc(kf_pose))
            result.n_keyframes += 1
            cb.on_camera(result.cameras[-1])
            cb.on_status("reconstructing", progress)

        cap.release()
        return result

    # ------------------------------------------------------------------ #

    def _intrinsics(self, w: int, h: int) -> np.ndarray:
        f = w / (2.0 * math.tan(math.radians(self.cfg.fov_deg) / 2.0))
        return np.array([[f, 0, w / 2.0], [0, f, h / 2.0], [0, 0, 1]], dtype=np.float64)

    def _detect(self, gray: np.ndarray, tracks: list[Track]) -> list[Track]:
        """Top up the corner budget, keeping distance from existing tracks."""
        cfg = self.cfg
        need = cfg.max_tracks - len(tracks)
        if need <= 0:
            return tracks
        mask = np.full(gray.shape, 255, np.uint8)
        for t in tracks:
            cv2.circle(mask, tuple(np.int32(t.pt)), cfg.grid_cell, 0, -1)
        pts = cv2.goodFeaturesToTrack(
            gray, maxCorners=need, qualityLevel=0.005,
            minDistance=cfg.grid_cell, mask=mask, blockSize=7)
        if pts is not None:
            for p in pts.reshape(-1, 2):
                tracks.append(Track(pt=p.astype(np.float64), kf_pt=p.astype(np.float64)))
        return tracks

    def _flow(self, prev: np.ndarray, cur: np.ndarray, tracks: list[Track]) -> list[Track]:
        """LK step with forward-backward consistency check."""
        cfg = self.cfg
        if not tracks:
            return tracks
        p0 = np.array([t.pt for t in tracks], np.float32).reshape(-1, 1, 2)
        lk = dict(winSize=(cfg.lk_win, cfg.lk_win), maxLevel=3,
                  criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
        p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, p0, None, **lk)
        p0r, st_b, _ = cv2.calcOpticalFlowPyrLK(cur, prev, p1, None, **lk)
        fb = np.linalg.norm(p0.reshape(-1, 2) - p0r.reshape(-1, 2), axis=1)
        h, w = cur.shape
        good = (st.ravel() == 1) & (st_b.ravel() == 1) & (fb < cfg.fb_max_err)
        p1 = p1.reshape(-1, 2)
        inside = (p1[:, 0] >= 0) & (p1[:, 0] < w - 1) & (p1[:, 1] >= 0) & (p1[:, 1] < h - 1)
        good &= inside
        kept = []
        for t, ok, p in zip(tracks, good, p1):
            if ok:
                t.pt = p.astype(np.float64)
                kept.append(t)
        return kept

    def _bootstrap(self, tracks, K, kf_pose, landmarks, frame, result):
        """Two-view initialization from the last keyframe to the current frame."""
        cfg = self.cfg
        p0 = np.array([t.kf_pt for t in tracks], np.float64)
        p1 = np.array([t.pt for t in tracks], np.float64)
        if len(p0) < 60:
            return None
        E, inl = cv2.findEssentialMat(p0, p1, K, method=cv2.RANSAC, prob=0.999, threshold=1.0)
        if E is None or E.shape != (3, 3):
            return None
        n_pose, R, t, pose_mask = cv2.recoverPose(E, p0, p1, K, mask=inl)
        if n_pose < 50:
            return None
        pose = np.hstack([R, t]).astype(np.float64)   # world-to-camera (kf0 is world)
        sel = pose_mask.ravel().astype(bool)
        self._add_landmarks(tracks, sel, K, kf_pose, pose, frame, landmarks, result)
        return pose

    def _localize(self, tracks, landmarks, K):
        """PnP on tracks that already carry a triangulated landmark."""
        obj, img, idxs = [], [], []
        for i, t in enumerate(tracks):
            if t.landmark >= 0:
                obj.append(landmarks[t.landmark])
                img.append(t.pt)
                idxs.append(i)
        if len(obj) < 25:
            return None
        obj = np.asarray(obj, np.float64)
        img = np.asarray(img, np.float64)
        ok, rvec, tvec, inliers = cv2.solvePnPRansac(
            obj, img, K, None, reprojectionError=3.0,
            iterationsCount=200, flags=cv2.SOLVEPNP_ITERATIVE)
        if not ok or inliers is None or len(inliers) < 20:
            return None
        inlier_set = set(int(i) for i in inliers.ravel())
        for j, i in enumerate(idxs):
            if j not in inlier_set:
                tracks[i].landmark = -1  # demote outliers; they may re-triangulate
        R, _ = cv2.Rodrigues(rvec)
        return np.hstack([R, tvec.reshape(3, 1)]).astype(np.float64)

    def _triangulate_new(self, tracks, K, pose_a, pose_b, landmarks, frame, result):
        sel = np.array([t.landmark < 0 for t in tracks], bool)
        if sel.sum() >= 8:
            self._add_landmarks(tracks, sel, K, pose_a, pose_b, frame, landmarks, result)

    def _triangulate_filtered(self, pa, pb, K, pose_a, pose_b, max_reproj):
        """Triangulate 2D correspondences between two poses.

        Returns the world points and a validity mask (cheirality, reprojection
        error in both views, parallax, and far-field depth clipping).
        """
        cfg = self.cfg
        Pa, Pb = K @ pose_a, K @ pose_b
        Xh = cv2.triangulatePoints(Pa, Pb, pa.T, pb.T)
        X = (Xh[:3] / np.where(np.abs(Xh[3]) < 1e-12, 1e-12, Xh[3])).T  # (N,3) world

        Ra, ta = pose_a[:, :3], pose_a[:, 3]
        Rb, tb = pose_b[:, :3], pose_b[:, 3]
        Xa = X @ Ra.T + ta   # camera-frame coordinates
        Xb = X @ Rb.T + tb
        good = (Xa[:, 2] > 1e-3) & (Xb[:, 2] > 1e-3)

        ra = Xa[:, :2] / Xa[:, 2:3] * K[0, 0] + K[:2, 2]
        rb = Xb[:, :2] / Xb[:, 2:3] * K[0, 0] + K[:2, 2]
        good &= np.linalg.norm(ra - pa, axis=1) < max_reproj
        good &= np.linalg.norm(rb - pb, axis=1) < max_reproj

        Ca, Cb = -Ra.T @ ta, -Rb.T @ tb
        va, vb = X - Ca, X - Cb
        cosang = np.sum(va * vb, axis=1) / (
            np.linalg.norm(va, axis=1) * np.linalg.norm(vb, axis=1) + 1e-12)
        good &= np.degrees(np.arccos(np.clip(cosang, -1, 1))) > cfg.min_parallax_deg

        med_depth = np.median(Xb[good, 2]) if good.any() else 1.0
        good &= Xb[:, 2] < med_depth * 12
        return X, good

    def _emit(self, X, keep, pb, frame, result):
        """Color the kept points from the current frame and stream them out."""
        h, w = frame.shape[:2]
        new_xyz = X[keep].astype(np.float32)
        px = np.clip(np.round(pb[keep]).astype(int), [0, 0], [w - 1, h - 1])
        new_rgb = frame[px[:, 1], px[:, 0], ::-1].copy()  # BGR -> RGB
        result.xyz = np.vstack([result.xyz, new_xyz])
        result.rgb = np.vstack([result.rgb, new_rgb])
        self.cb.on_points(new_xyz, new_rgb)

    def _add_landmarks(self, tracks, sel, K, pose_a, pose_b, frame, landmarks, result):
        """Triangulate selected tracks between two keyframe poses, filter and emit."""
        cfg = self.cfg
        idxs = np.flatnonzero(sel)
        pa = np.array([tracks[i].kf_pt for i in idxs], np.float64)
        pb = np.array([tracks[i].pt for i in idxs], np.float64)
        X, good = self._triangulate_filtered(pa, pb, K, pose_a, pose_b, cfg.max_reproj_err)

        keep = np.flatnonzero(good)
        if len(keep) > cfg.max_points_per_kf:
            keep = np.random.choice(keep, cfg.max_points_per_kf, replace=False)
        if len(keep) == 0:
            return

        base = len(landmarks)
        for j, k in enumerate(keep):
            landmarks.append(X[k])
            tracks[idxs[k]].landmark = base + j
        self._emit(X, keep, pb, frame, result)

    def _densify(self, gray_a, gray_b, frame_b, K, pose_a, pose_b, result):
        """Triangulate a dense grid of textured pixels between two keyframes.

        The sparse map above exists to estimate poses; this pass reuses those
        poses to fill the cloud, tracking every N-th pixel with enough gradient
        from the previous keyframe to the current one.
        """
        cfg = self.cfg
        if len(result.xyz) >= cfg.max_total_points:
            return
        gx = cv2.Sobel(gray_a, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(gray_a, cv2.CV_32F, 0, 1, ksize=3)
        mag = cv2.magnitude(gx, gy)
        s = cfg.densify_stride
        ys, xs = np.mgrid[s // 2:gray_a.shape[0]:s, s // 2:gray_a.shape[1]:s]
        m = mag[ys, xs] > cfg.densify_grad_thresh
        pa = np.column_stack([xs[m], ys[m]]).astype(np.float32)
        if len(pa) < 50:
            return
        if len(pa) > 45000:
            pa = pa[np.random.choice(len(pa), 45000, replace=False)]

        lk = dict(winSize=(15, 15), maxLevel=4,
                  criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
        pb, st, _ = cv2.calcOpticalFlowPyrLK(gray_a, gray_b, pa.reshape(-1, 1, 2), None, **lk)
        par, st_b, _ = cv2.calcOpticalFlowPyrLK(gray_b, gray_a, pb, None, **lk)
        fb = np.linalg.norm(pa - par.reshape(-1, 2), axis=1)
        pb = pb.reshape(-1, 2)
        h, w = gray_b.shape
        ok = (st.ravel() == 1) & (st_b.ravel() == 1) & (fb < 1.0)
        ok &= (pb[:, 0] >= 0) & (pb[:, 0] < w - 1) & (pb[:, 1] >= 0) & (pb[:, 1] < h - 1)
        if ok.sum() < 50:
            return
        pa, pb = pa[ok].astype(np.float64), pb[ok].astype(np.float64)

        X, good = self._triangulate_filtered(pa, pb, K, pose_a, pose_b,
                                             cfg.densify_max_reproj)
        keep = np.flatnonzero(good)
        if len(keep) > cfg.densify_max_per_kf:
            keep = np.random.choice(keep, cfg.densify_max_per_kf, replace=False)
        if len(keep):
            self._emit(X, keep, pb, frame_b, result)


def _to_Twc(pose_wc_3x4: np.ndarray) -> np.ndarray:
    """3x4 world-to-camera [R|t] -> 4x4 camera-to-world transform."""
    R, t = pose_wc_3x4[:, :3], pose_wc_3x4[:, 3]
    T = np.eye(4)
    T[:3, :3] = R.T
    T[:3, 3] = -R.T @ t
    return T
