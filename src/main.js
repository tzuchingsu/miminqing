// src/main.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { characterRoot } from "./character.js";
import { createTerrain, updateTerrainTime } from "./terrain.js";
import { initBoids, updateBoids } from "./Boids.js";
import { LSystemPlant } from "./lsystem.js";

/* 調整：數量更多、尺寸更大、可無限長大 */
const INITIAL_PLANT_COUNT = 18;
const MIN_SCALE_BY_CHAR = 3.4;
const RANDOM_SCALE_JITTER = [1.2, 2.2];
const AUTO_SPAWN_MAX = 60;
const AUTO_SPAWN_EVERY_N_TICKS = 3;
const INFINITE_GROW_INTERVAL_MS = 650;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.background = new THREE.Color(0x0f0f12);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(10, 7, 12);
camera.lookAt(0, 1.8, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1.8, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.55));
const dir = new THREE.DirectionalLight(0xffffff, 0.95);
dir.position.set(6, 14, 8);
scene.add(dir);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.4,
  0.22,
  0.78
);
composer.addPass(bloomPass);

/* ───────── 地形貼地工具 ───────── */
const raycaster = new THREE.Raycaster();
function rayDownYToTerrain(terrain, x, z, maxY = 500) {
  if (!terrain) return null;
  const origin = new THREE.Vector3(x, maxY, z);
  raycaster.set(origin, new THREE.Vector3(0, -1, 0));
  return raycaster.intersectObject(terrain, true)[0] || null;
}
function findRandomPointOnTerrain(terrain, tries = 140) {
  const box = new THREE.Box3().setFromObject(terrain);
  for (let i = 0; i < tries; i++) {
    const x = THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random());
    const z = THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random());
    const hit = rayDownYToTerrain(terrain, x, z, (box.max.y || 200) + 300);
    if (hit) return hit.point;
  }
  return new THREE.Vector3(0, 0, 0);
}
function findHighestPointOnTerrain(terrain, samples = 560) {
  const box = new THREE.Box3().setFromObject(terrain);
  const min = box.min,
    max = box.max;
  let best = null;
  for (let i = 0; i < samples; i++) {
    const x = THREE.MathUtils.lerp(min.x, max.x, Math.random());
    const z = THREE.MathUtils.lerp(min.z, max.z, Math.random());
    const h = rayDownYToTerrain(terrain, x, z, max.y + 300);
    if (!h) continue;
    if (!best || h.point.y > best.point.y) best = { point: h.point.clone() };
  }
  return best ? best.point : new THREE.Vector3(0, 0, 0);
}

/* ───────── 狀態 ───────── */
let terrainRoot = null;
let characterObjGroup = null;
const plants = [];
let infiniteGrowTimer = null;
let autoSpawnTick = 0;

/* ───────── 初始化 ───────── */
async function init() {
  try {
    terrainRoot = await createTerrain({
      size: 200,
      segments: 128,
      AMP: 22.0,
      FREQ: 0.038,
      vertPath: "./src/shaders/terrain.vert.glsl",
      fragPath: "./src/shaders/terrain.frag.glsl",
    });
    scene.add(terrainRoot);

    characterObjGroup = await characterRoot;
    scene.add(characterObjGroup);
    const prototypeNode =
      (characterObjGroup.children?.[0]) || characterObjGroup;
    initBoids({
      scene,
      camera,
      renderer,
      terrainRoot,
      prototypeNode,
      count: 22,
    });

    spawnPlantsOnTerrain({ count: INITIAL_PLANT_COUNT, oneOnPeak: true });

    plants.forEach((p) => p.update(0));
    update(0);
    setupUI();
  } catch (err) {
    console.error("[main] 初始化錯誤：", err);
  }
}
init();

function scalePlantByCharacter(p) {
  const charBox = new THREE.Box3().setFromObject(characterObjGroup);
  const charH = Math.max(0.001, charBox.max.y - charBox.min.y);
  const targetH = charH * MIN_SCALE_BY_CHAR;
  const plantH = p.estimateHeight();
  let s = plantH > 0 ? targetH / plantH : MIN_SCALE_BY_CHAR;
  s *= THREE.MathUtils.lerp(
    RANDOM_SCALE_JITTER[0],
    RANDOM_SCALE_JITTER[1],
    Math.random()
  );
  p.object3d.scale.setScalar(s);
  p.object3d.rotation.y = Math.random() * Math.PI * 2;
}

function spawnPlantsOnTerrain({ count = 12, oneOnPeak = false } = {}) {
  if (oneOnPeak) {
    const peak = findHighestPointOnTerrain(terrainRoot, 520);
    const plant = new LSystemPlant({
      seed: Math.floor(Math.random() * 1e9),
      genMax: 5,
      step: 0.9,
      baseRadius: 0.24,
      angleDeg: 26,
      branchPerLevel: 4,
      leafClusterCount: 6,
      leafSize: 1.4,
      glowFactor: 0.9,
    });
    plant.object3d.position.copy(peak);
    scene.add(plant.object3d);
    scalePlantByCharacter(plant);
    plants.push(plant);
  }
  for (let i = 0; i < count; i++) {
    const pos = findRandomPointOnTerrain(terrainRoot);
    const plant = new LSystemPlant({
      seed: Math.floor(Math.random() * 1e9),
      genMax: 4 + Math.floor(Math.random() * 2),           // 4~5 層
      step: 0.8 + Math.random() * 0.25,
      baseRadius: 0.18 + Math.random() * 0.1,
      angleDeg: 22 + Math.random() * 18,                   // 每棵角度有差
      branchPerLevel: 3 + Math.floor(Math.random() * 3),   // 3~5 根側枝
      leafClusterCount: 4 + Math.floor(Math.random() * 4), // 4~7 片葉
      leafSize: 1.1 + Math.random() * 0.6,
      glowFactor: 0.8 + Math.random() * 0.6,              // 每棵初始亮度也略不同
    });
    plant.object3d.position.copy(pos);
    scene.add(plant.object3d);
    scalePlantByCharacter(plant);
    plants.push(plant);
  }
}

/* 🔆 控制所有樹的發光亮度：Z 降低，X 提高 */
function changeGlowFactor(scale) {
  plants.forEach((p) => {
    if (typeof p.getGlowFactor === "function" &&
        typeof p.setGlowFactor === "function") {
      const current = p.getGlowFactor();
      p.setGlowFactor(current * scale);
    }
  });
}

/* ───────── 事件 ───────── */
window.addEventListener("resize", () => {
  const w = window.innerWidth,
    h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

window.addEventListener("keydown", (e) => {
  switch (e.key) {
    case " ": plants.forEach((p) => p.togglePlay()); break;
    case "[": plants.forEach((p) => p.addGen(-1)); break;
    case "]":
    case "+":
    case "=": plants.forEach((p) => p.addGen(+1)); break;

    // 樹的角度（側枝整體往上、往外展）
    case "j":
    case "J": plants.forEach((p) => p.addAngle(-2)); break;
    case "k":
    case "K": plants.forEach((p) => p.addAngle(+2)); break;

    case "n":
    case "N": plants.forEach((p) => p.addDecay(+0.03)); break;
    case "m":
    case "M": plants.forEach((p) => p.addDecay(-0.03)); break;

    // 不再用 D 控制亮度（日夜自動關掉）
    // case "d":
    // case "D": plants.forEach((p) => p.toggleDayNight()); break;

    case "g":
    case "G": toggleInfiniteGrow(); break;

    // 🔅 變暗
    case "z":
    case "Z": changeGlowFactor(0.8); break;

    // 🔆 變亮
    case "x":
    case "X": changeGlowFactor(1.25); break;
  }
});

/* 無限成長：持續 +1 代並定期增新樹 */
function startInfiniteGrow(ms = INFINITE_GROW_INTERVAL_MS) {
  if (infiniteGrowTimer) return;
  infiniteGrowTimer = setInterval(() => {
    plants.forEach((p) => p.addGen(+1));
    autoSpawnTick++;
    if (
      autoSpawnTick % AUTO_SPAWN_EVERY_N_TICKS === 0 &&
      plants.length < AUTO_SPAWN_MAX
    ) {
      spawnPlantsOnTerrain({ count: 1, oneOnPeak: false });
    }
    setGrowButtonState(true);
  }, ms);
  setGrowButtonState(true);
}
function stopInfiniteGrow() {
  if (!infiniteGrowTimer) return;
  clearInterval(infiniteGrowTimer);
  infiniteGrowTimer = null;
  setGrowButtonState(false);
}
function toggleInfiniteGrow() {
  if (infiniteGrowTimer) stopInfiniteGrow();
  else startInfiniteGrow();
}

/* 迴圈 */
const clock = new THREE.Clock();
function update(dt) {
  updateTerrainTime(terrainRoot, dt);
  const tSec = performance.now() * 0.001;
  updateBoids(dt, tSec);
  plants.forEach((p) => p.update(dt));
}
(function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  controls.update();
  composer.render();
})();

/* 簡易 UI（選填） */
function setupUI() {
  const btn = document.getElementById("btn-grow");
  const stop = document.getElementById("btn-stop");
  btn?.addEventListener("click", () => toggleInfiniteGrow());
  stop?.addEventListener("click", () => stopInfiniteGrow());

  const dim = document.getElementById("btn-dim");
  const bright = document.getElementById("btn-bright");
  dim?.addEventListener("click", () => changeGlowFactor(0.8));
  bright?.addEventListener("click", () => changeGlowFactor(1.25));
}
function setGrowButtonState(active) {
  const btn = document.getElementById("btn-grow");
  if (!btn) return;
  btn.textContent = active
    ? "⏸ 停止無限成長 (G)"
    : "▶ 無限成長 (G)";
}
