"""Exporters: point-cloud PLY, 3D Gaussian Splatting PLY, antimatter15 .splat.

The SfM pipeline produces points, not optimized gaussians, so the splat
exporters initialize one gaussian per point: isotropic scale from the local
nearest-neighbor spacing, identity rotation, constant opacity, and the point
color as the spherical-harmonics DC term. The result loads in standard 3DGS
viewers (SuperSplat, antimatter15/splat, gsplat, ...).
"""

from __future__ import annotations

import io
import struct

import numpy as np
from scipy.spatial import cKDTree

SH_C0 = 0.28209479177387814
DEFAULT_OPACITY = 0.92


def clean_outliers(xyz: np.ndarray, rgb: np.ndarray, k: int = 8, sigma: float = 2.5):
    """Drop points whose mean k-NN distance is far above the global average."""
    if len(xyz) < k + 1:
        return xyz, rgb
    tree = cKDTree(xyz)
    d, _ = tree.query(xyz, k=k + 1, workers=-1)
    mean_d = d[:, 1:].mean(axis=1)
    thresh = mean_d.mean() + sigma * mean_d.std()
    keep = mean_d < thresh
    return xyz[keep], rgb[keep]


def _knn_scales(xyz: np.ndarray, k: int = 4) -> np.ndarray:
    """Isotropic gaussian radius from the local point spacing."""
    if len(xyz) <= k:
        return np.full(len(xyz), 0.02, np.float32)
    tree = cKDTree(xyz)
    d, _ = tree.query(xyz, k=k + 1, workers=-1)
    s = d[:, 1:].mean(axis=1) * 0.6
    lo, hi = np.percentile(s, [1, 99])
    return np.clip(s, max(lo, 1e-6), hi).astype(np.float32)


def pointcloud_ply(xyz: np.ndarray, rgb: np.ndarray) -> bytes:
    n = len(xyz)
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {n}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "end_header\n"
    ).encode("ascii")
    rec = np.zeros(n, dtype=[("xyz", np.float32, 3), ("rgb", np.uint8, 3)])
    rec["xyz"] = xyz
    rec["rgb"] = rgb
    return header + rec.tobytes()


def gaussian_ply(xyz: np.ndarray, rgb: np.ndarray) -> bytes:
    """3DGS-format PLY (the layout written by the original INRIA trainer)."""
    n = len(xyz)
    scales = _knn_scales(xyz)
    fields = ["x", "y", "z", "nx", "ny", "nz",
              "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2",
              "rot_0", "rot_1", "rot_2", "rot_3"]
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {n}\n"
        + "".join(f"property float {f}\n" for f in fields)
        + "end_header\n"
    ).encode("ascii")

    data = np.zeros((n, len(fields)), np.float32)
    data[:, 0:3] = xyz
    data[:, 6:9] = (rgb.astype(np.float32) / 255.0 - 0.5) / SH_C0
    data[:, 9] = np.log(DEFAULT_OPACITY / (1.0 - DEFAULT_OPACITY))  # inverse sigmoid
    data[:, 10:13] = np.log(scales)[:, None]
    data[:, 13] = 1.0  # identity quaternion (w,x,y,z)
    return header + data.tobytes()


def splat_binary(xyz: np.ndarray, rgb: np.ndarray) -> bytes:
    """antimatter15 .splat: 32 bytes per gaussian, sorted big-to-small."""
    n = len(xyz)
    scales = _knn_scales(xyz)
    order = np.argsort(-scales)  # the reference viewer expects large splats first
    buf = io.BytesIO()
    alpha = int(DEFAULT_OPACITY * 255)
    quat = struct.pack("4B", 255, 128, 128, 128)  # identity (w,x,y,z) * 128 + 128
    for i in order:
        buf.write(struct.pack("3f", *xyz[i]))
        buf.write(struct.pack("3f", scales[i], scales[i], scales[i]))
        buf.write(struct.pack("4B", int(rgb[i, 0]), int(rgb[i, 1]), int(rgb[i, 2]), alpha))
        buf.write(quat)
    return buf.getvalue()
