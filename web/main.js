import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { PointerLockControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/PointerLockControls.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(new THREE.Color('#0f172a'));

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2('#0f172a', 0.02);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.6, 6);

const controls = new PointerLockControls(camera, document.body);
scene.add(controls.getObject());

const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const scoreEl = document.getElementById('score');
const shoutEl = document.getElementById('shout');

let elves = [];
let defeated = 0;
let wave = 1;

const clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const move = { forward: false, backward: false, left: false, right: false, jump: false, grounded: false };

function setupLights() {
  const ambient = new THREE.AmbientLight(0xf8fafc, 0.55);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(4, 8, 2);
  scene.add(dir);
}

function buildGround() {
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.9, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function makeElf(position) {
  const geo = new THREE.BoxGeometry(0.8, 1.4, 0.8);
  const mat = new THREE.MeshStandardMaterial({ color: '#22c55e', emissive: '#14532d', roughness: 0.4, metalness: 0.15 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  mesh.position.y = 0.7;
  mesh.castShadow = true;
  return mesh;
}

function randomPos(radius = 12) {
  const angle = Math.random() * Math.PI * 2;
  const dist = THREE.MathUtils.lerp(4, radius, Math.random());
  return new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
}

function spawnWave(count) {
  elves.forEach((elf) => scene.remove(elf));
  elves = [];

  for (let i = 0; i < count; i += 1) {
    const pos = randomPos();
    const elf = makeElf(pos);
    elves.push(elf);
    scene.add(elf);
  }

  statusEl.textContent = `Wave ${wave}`;
}

function setShout(text) {
  shoutEl.textContent = text;
  if (text) {
    shoutEl.animate(
      [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-6px)', opacity: 0 }],
      { duration: 700, easing: 'ease-out' }
    );
  }
}

function onMouseDown(event) {
  if (!controls.isLocked) {
    controls.lock();
    return;
  }

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(), camera);
  const hits = raycaster.intersectObjects(elves);

  if (hits.length) {
    const [hit] = hits;
    scene.remove(hit.object);
    elves = elves.filter((e) => e !== hit.object);
    defeated += 1;
    scoreEl.textContent = `Elves defeated: ${defeated}`;
    setShout('One Off!');
  }

  if (elves.length === 0) {
    wave += 1;
    spawnWave(Math.min(5 + wave * 2, 30));
    setShout('Wave cleared!');
  }
}

function onKeyDown(event) {
  switch (event.code) {
    case 'KeyW':
      move.forward = true;
      break;
    case 'KeyS':
      move.backward = true;
      break;
    case 'KeyA':
      move.left = true;
      break;
    case 'KeyD':
      move.right = true;
      break;
    case 'Space':
      if (move.grounded) {
        velocity.y += 6.5;
        move.grounded = false;
      }
      break;
    default:
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case 'KeyW':
      move.forward = false;
      break;
    case 'KeyS':
      move.backward = false;
      break;
    case 'KeyA':
      move.left = false;
      break;
    case 'KeyD':
      move.right = false;
      break;
    default:
      break;
  }
}

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function updatePlayer(delta) {
  const damping = 10.0;
  const speed = 18.0;

  velocity.x -= velocity.x * damping * delta;
  velocity.z -= velocity.z * damping * delta;
  velocity.y -= 18 * delta; // gravity

  direction.set(Number(move.right) - Number(move.left), 0, Number(move.backward) - Number(move.forward));
  direction.normalize();

  if (move.forward || move.backward) velocity.z -= direction.z * speed * delta;
  if (move.left || move.right) velocity.x -= direction.x * speed * delta;

  controls.moveRight(-velocity.x * delta);
  controls.moveForward(-velocity.z * delta);

  const position = controls.getObject().position;
  position.y += velocity.y * delta;

  if (position.y < 1.6) {
    velocity.y = 0;
    position.y = 1.6;
    move.grounded = true;
  }
}

function tick() {
  requestAnimationFrame(tick);
  const delta = Math.min(clock.getDelta(), 0.05);

  if (controls.isLocked) {
    overlay.classList.add('hidden');
    updatePlayer(delta);
  }

  const time = performance.now() * 0.001;
  elves.forEach((elf) => {
    elf.rotation.y += 0.6 * delta;
    elf.position.y = 0.7 + Math.sin(time + elf.position.x) * 0.05;
  });

  renderer.render(scene, camera);
}

function init() {
  setupLights();
  buildGround();
  spawnWave(6);

  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', handleResize);

  controls.addEventListener('lock', () => overlay.classList.add('hidden'));
  controls.addEventListener('unlock', () => overlay.classList.remove('hidden'));

  tick();
}

init();
