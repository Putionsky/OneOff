import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";

/* ---------------------------------------------------------------- scene */

const viewport = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xfafafa);

// The reconstruction lives in the first camera's frame: +X right, +Y DOWN,
// +Z forward. "Top (-Y)" is therefore the bird's-eye view.
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5000);
camera.up.set(0, -1, 0);
camera.position.set(0, -1, -3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
let userMoved = false;
controls.addEventListener("start", () => { userMoved = true; });

/* growing point cloud ------------------------------------------------- */

let capacity = 250_000;
let nPoints = 0;
let positions = new Float32Array(capacity * 3);
let colors = new Float32Array(capacity * 3);
let radii = new Float32Array(capacity);

const geometry = new THREE.BufferGeometry();

// Splats are drawn as screen-facing discs: size follows the per-point radius
// streamed from the backend (local neighbor spacing), attenuated by distance
// and clamped so close-ups never degenerate into giant blocks.
const material = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: true,
  uniforms: {
    uPixelFactor: { value: 1 },   // drawingBufferHeight / (2 tan(fov/2))
    uSizeMult: { value: 1 },
    uMaxSize: { value: 26 },
  },
  vertexShader: /* glsl */`
    attribute float radius;
    attribute vec3 aColor;
    varying vec3 vColor;
    uniform float uPixelFactor, uSizeMult, uMaxSize;
    void main() {
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float px = 2.0 * radius * uSizeMult * uPixelFactor / max(-mv.z, 1e-5);
      gl_PointSize = clamp(px, 1.5, uMaxSize);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vColor;
    void main() {
      vec2 c = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(c, c);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(vColor, smoothstep(1.0, 0.55, r2));  // gaussian-ish rim
    }`,
});

function rebuildAttributes() {
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("radius", new THREE.BufferAttribute(radii, 1));
}
rebuildAttributes();
geometry.setDrawRange(0, 0);

const points = new THREE.Points(geometry, material);
points.frustumCulled = false;
scene.add(points);

function appendPoints(xyz, rgb, rad) {
  const n = xyz.length / 3;
  if (nPoints + n > capacity) {
    while (nPoints + n > capacity) capacity *= 2;
    const p = new Float32Array(capacity * 3); p.set(positions.subarray(0, nPoints * 3));
    const c = new Float32Array(capacity * 3); c.set(colors.subarray(0, nPoints * 3));
    const r = new Float32Array(capacity); r.set(radii.subarray(0, nPoints));
    positions = p; colors = c; radii = r;
    rebuildAttributes();
  }
  positions.set(xyz, nPoints * 3);
  for (let i = 0; i < n * 3; i++) colors[nPoints * 3 + i] = rgb[i] / 255;
  if (rad) radii.set(rad, nPoints);
  else radii.fill(sceneDiag / 300, nPoints, nPoints + n);  // legacy chunks
  nPoints += n;
  geometry.setDrawRange(0, nPoints);
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.aColor.needsUpdate = true;
  geometry.attributes.radius.needsUpdate = true;
  document.getElementById("stat-points").textContent = nPoints.toLocaleString();
  refreshScale();
  if (!userMoved) setView("overview");
}

/* camera trail --------------------------------------------------------- */

const camPoses = [];            // THREE.Matrix4 camera-to-world
const trail = new THREE.Group();
scene.add(trail);

function rebuildTrail(size) {
  trail.clear();
  const d = size;
  const corners = [
    new THREE.Vector3(-d, -d * 0.7, d * 1.6), new THREE.Vector3(d, -d * 0.7, d * 1.6),
    new THREE.Vector3(d, d * 0.7, d * 1.6), new THREE.Vector3(-d, d * 0.7, d * 1.6),
  ];
  const verts = [];
  for (const c of corners) verts.push(0, 0, 0, c.x, c.y, c.z);
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const frustumGeo = new THREE.BufferGeometry();
  frustumGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x28a745 });
  const centers = [];
  for (const m of camPoses) {
    const seg = new THREE.LineSegments(frustumGeo, mat);
    seg.applyMatrix4(m);
    trail.add(seg);
    centers.push(new THREE.Vector3().setFromMatrixPosition(m));
  }
  if (centers.length > 1) {
    const pathGeo = new THREE.BufferGeometry().setFromPoints(centers);
    trail.add(new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: 0x2f7cf6 })));
  }
  document.getElementById("stat-cams").textContent = camPoses.length;
}

/* ground grid + adaptive sizing ---------------------------------------- */

let grid = null;
let sceneDiag = 4;

function bounds() {
  const box = new THREE.Box3();
  const stride = Math.max(1, Math.floor(nPoints / 60_000)) * 3;
  const v = new THREE.Vector3();
  for (let i = 0; i < nPoints * 3; i += stride)
    box.expandByPoint(v.set(positions[i], positions[i + 1], positions[i + 2]));
  for (const m of camPoses) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(m));
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  return box;
}

function refreshScale() {
  const box = bounds();
  const diag = box.getSize(new THREE.Vector3()).length();
  if (diag > sceneDiag * 1.3 || diag < sceneDiag * 0.5 || !grid) {
    sceneDiag = Math.max(diag, 1e-3);
    rebuildTrail(sceneDiag / 70);
    if (grid) scene.remove(grid);
    grid = new THREE.GridHelper(sceneDiag * 1.5, 24, 0xdddddd, 0xe8e8e8);
    const c = box.getCenter(new THREE.Vector3());
    grid.position.set(c.x, box.max.y, c.z);  // +Y is down, so the ground sits at max Y
    scene.add(grid);
  } else {
    rebuildTrail(sceneDiag / 70);
  }
}

/* view presets ---------------------------------------------------------- */

const VIEW_DIRS = {
  front: [0, 0, -1], back: [0, 0, 1],
  left: [-1, 0, 0], right: [1, 0, 0],
  top: [0, -1, 0], bottom: [0, 1, 0],
  overview: [-0.55, -0.6, -0.65],
};

function setView(name) {
  const box = bounds();
  const c = box.getCenter(new THREE.Vector3());
  if (name === "center") { controls.target.copy(c); controls.update(); return; }
  const dir = new THREE.Vector3(...VIEW_DIRS[name]).normalize();
  const dist = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3) * 0.9;
  camera.position.copy(c).addScaledVector(dir, dist);
  camera.up.set(0, -1, 0);
  if (name === "top") camera.up.set(0, 0, 1);
  if (name === "bottom") camera.up.set(0, 0, -1);
  controls.target.copy(c);
  controls.update();
}

document.querySelectorAll("[data-view]").forEach(b =>
  b.addEventListener("click", () => { userMoved = true; setView(b.dataset.view); }));

document.getElementById("btn-up").addEventListener("click", () => {
  // adopt the current on-screen up as the world up for orbiting
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.up.copy(up);
  controls.update();
});

/* axis gizmo ------------------------------------------------------------ */

const gizmoScene = new THREE.Scene();
gizmoScene.add(new THREE.AxesHelper(1));
const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);

function renderGizmo() {
  const s = 74 * window.devicePixelRatio;
  renderer.setScissorTest(true);
  renderer.setScissor(8, 8, s, s);
  renderer.setViewport(8, 8, s, s);
  gizmoCam.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(3);
  gizmoCam.up.copy(camera.up);
  gizmoCam.lookAt(0, 0, 0);
  renderer.autoClear = false;   // draw over the main render, keep its color
  renderer.clearDepth();
  renderer.render(gizmoScene, gizmoCam);
  renderer.autoClear = true;
  renderer.setScissorTest(false);
}

/* render loop ----------------------------------------------------------- */

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  material.uniforms.uPixelFactor.value =
    buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setViewport(0, 0, w, h);
  renderer.render(scene, camera);
  renderGizmo();
});

/* ------------------------------------------------------------------ UI */

const el = id => document.getElementById(id);
const toast = (msg, ms = 3200) => {
  el("toast").textContent = msg;
  el("toast").classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el("toast").classList.remove("show"), ms);
};

const STATE_LABEL = {
  idle: "Waiting for video", processing: "Processing",
  ready: "Scene ready", error: "Error",
};

function applyStatus(s) {
  let label = STATE_LABEL[s.state] ?? s.state;
  if (s.state === "processing") {
    const pct = Math.round(s.progress * 100);
    label = `Processing… ${pct}%` + (s.detail ? ` — ${s.detail}` : "");
    el("drop-hint").classList.add("hidden");
  }
  el("scene-state").textContent = label;
  el("title-state").textContent = STATE_LABEL[s.state] ?? s.state;
  el("title-dot").className = "dot " +
    ({ ready: "ready", processing: "busy", error: "error" }[s.state] ?? "");
  el("progress-fill").style.width =
    s.state === "processing" ? `${s.progress * 100}%` : "0";
  const canSave = s.state === "ready" && s.n_points > 0;
  el("btn-save-pc").disabled = !canSave;
  el("btn-save-splat").disabled = !canSave;
  if (s.state === "error" && s.detail) toast(s.detail, 6000);
  if (s.state === "ready") el("drop-hint").classList.add("hidden");
}

function resetScene() {
  nPoints = 0;
  geometry.setDrawRange(0, 0);
  camPoses.length = 0;
  trail.clear();
  userMoved = false;
  el("stat-points").textContent = "0";
  el("stat-cams").textContent = "0";
}

/* upload ---------------------------------------------------------------- */

async function upload(file) {
  const fd = new FormData();
  fd.append("file", file);
  el("scene-state").textContent = "Uploading…";
  el("drop-hint").classList.add("hidden");
  const r = await fetch("/api/video", { method: "POST", body: fd });
  if (!r.ok) toast("Upload failed");
}

el("btn-new").addEventListener("click", () => el("file-input").click());
el("file-input").addEventListener("change", e => {
  if (e.target.files[0]) upload(e.target.files[0]);
  e.target.value = "";
});
viewport.addEventListener("dragover", e => { e.preventDefault(); viewport.classList.add("dragover"); });
viewport.addEventListener("dragleave", () => viewport.classList.remove("dragover"));
viewport.addEventListener("drop", e => {
  e.preventDefault();
  viewport.classList.remove("dragover");
  const f = e.dataTransfer.files[0];
  if (f) upload(f);
});

/* toolbar --------------------------------------------------------------- */

el("btn-save-pc").addEventListener("click", () => {
  window.location.href = "/api/export/pointcloud.ply";
});

const menu = el("splat-menu");
el("btn-save-splat").addEventListener("click", e => {
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.left = `${r.right - 214}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.classList.toggle("hidden");
  e.stopPropagation();
});
document.addEventListener("click", () => menu.classList.add("hidden"));
menu.querySelectorAll(".menu-item").forEach(m =>
  m.addEventListener("click", () => {
    window.location.href = `/api/export/${m.dataset.fmt}`;
    menu.classList.add("hidden");
  }));

el("btn-reveal").addEventListener("click", async () => {
  const r = await fetch("/api/reveal", { method: "POST" });
  const { path } = await r.json();
  toast(`Exports folder: ${path}`);
});

el("chk-frame").addEventListener("change", e =>
  el("current-frame").classList.toggle("visible", e.target.checked && !!el("current-frame").src));

el("size-slider").addEventListener("input", e => {
  material.uniforms.uSizeMult.value = parseFloat(e.target.value);
});

window.__studio = { camera, controls, setView, material, geometry };  // for tests and debugging

/* ------------------------------------------------------------ websocket */

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    el("conn-label").textContent = "Connected";
    el("conn-dot").classList.remove("off");
  };
  ws.onclose = () => {
    el("conn-label").textContent = "Disconnected";
    el("conn-dot").classList.add("off");
    setTimeout(connect, 1500);
  };

  ws.onmessage = ev => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "reset") resetScene();
      else if (msg.type === "status") applyStatus(msg);
      else if (msg.type === "frame") {
        const img = el("current-frame");
        img.src = `data:image/jpeg;base64,${msg.jpg}`;
        if (el("chk-frame").checked) img.classList.add("visible");
      }
      return;
    }
    const dv = new DataView(ev.data);
    const type = dv.getUint32(0, true);
    const n = dv.getUint32(4, true);
    if (type === 1) {
      appendPoints(
        new Float32Array(ev.data, 8, n * 3),
        new Uint8Array(ev.data, 8 + n * 12, n * 3),
        null);
    } else if (type === 3) {
      // xyz f32*3n, rgb u8*3n, radius f32*n (offset re-aligned to 4 bytes)
      const rgb = new Uint8Array(ev.data, 8 + n * 12, n * 3);
      const radOff = 8 + n * 12 + n * 3;
      const rad = radOff % 4 === 0
        ? new Float32Array(ev.data, radOff, n)
        : new Float32Array(ev.data.slice(radOff, radOff + n * 4));
      appendPoints(new Float32Array(ev.data, 8, n * 3), rgb, rad);
    } else if (type === 2) {
      const f = new Float32Array(ev.data, 8, 16);
      camPoses.push(new THREE.Matrix4().set(...f));  // row-major from numpy
      refreshScale();
    }
  };
}
connect();
