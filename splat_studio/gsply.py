"""Reader for 3D Gaussian Splatting PLY files (the INRIA trainer layout,
also written by SHARP and most 3DGS tools): binary little-endian vertices
with x/y/z, f_dc_*, opacity, scale_*, rot_* float properties."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SH_C0 = 0.28209479177387814

_PLY_TYPES = {
    "float": "<f4", "float32": "<f4", "double": "<f8",
    "uchar": "u1", "uint8": "u1", "char": "i1",
    "short": "<i2", "ushort": "<u2",
    "int": "<i4", "uint": "<u4",
}


@dataclass
class GaussianScene:
    xyz: np.ndarray        # (N,3) float32
    rgb: np.ndarray        # (N,3) uint8, decoded from the SH DC term
    opacity: np.ndarray    # (N,) float32 in [0,1]
    scales: np.ndarray     # (N,3) float32, linear (not log)
    rots: np.ndarray       # (N,4) float32 quaternion (w,x,y,z), normalized


def read(data: bytes) -> GaussianScene:
    end = data.find(b"end_header\n")
    if not data.startswith(b"ply") or end < 0:
        raise ValueError("not a PLY file")
    header = data[:end].decode("ascii", "replace").splitlines()

    n = 0
    fields: list[tuple[str, str]] = []
    in_vertex = False
    for line in header:
        t = line.split()
        if not t:
            continue
        if t[0] == "format" and t[1] != "binary_little_endian":
            raise ValueError(f"unsupported PLY format: {t[1]}")
        if t[0] == "element":
            in_vertex = t[1] == "vertex"
            if in_vertex:
                n = int(t[2])
        elif t[0] == "property" and in_vertex:
            if t[1] == "list":
                raise ValueError("list properties are not supported")
            fields.append((t[2], _PLY_TYPES[t[1]]))

    names = [f[0] for f in fields]
    for req in ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                "scale_0", "scale_1", "scale_2"):
        if req not in names:
            raise ValueError(f"not a 3DGS PLY: missing property {req}")

    rec = np.frombuffer(data, dtype=np.dtype(fields),
                        count=n, offset=end + len(b"end_header\n"))

    def col(*keys):
        return np.column_stack([rec[k].astype(np.float32) for k in keys])

    xyz = col("x", "y", "z")
    dc = col("f_dc_0", "f_dc_1", "f_dc_2")
    rgb = np.clip((0.5 + SH_C0 * dc) * 255.0, 0, 255).astype(np.uint8)
    opacity = 1.0 / (1.0 + np.exp(-rec["opacity"].astype(np.float32)))
    scales = np.exp(col("scale_0", "scale_1", "scale_2"))
    if all(f"rot_{i}" in names for i in range(4)):
        rots = col("rot_0", "rot_1", "rot_2", "rot_3")
        norm = np.linalg.norm(rots, axis=1, keepdims=True)
        rots = rots / np.where(norm < 1e-12, 1.0, norm)
    else:
        rots = np.tile(np.array([1, 0, 0, 0], np.float32), (n, 1))
    return GaussianScene(xyz=xyz, rgb=rgb, opacity=opacity,
                         scales=scales.astype(np.float32), rots=rots)
