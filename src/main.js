// src/main.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

import { characterRoot } from "./character.js";
import { createTerrain, updateTerrainTime } from "./terrain.js";
import {
  initBoids,
  updateBoids,
  applyPopulationGenomes,
  markSelection,
  markNewborn,
  SURVIVAL_RATE,
  DEATH_ANIM_DURATION,
  SURVIVORS_WINDOW,
  NEWBORN_ANIM_DURATION,
} from "./Boids.js";
import { LSystemPlant } from "./lsystem.js";
import { GeneticAlgorithm } from "./ga.js";

// 전역 Tone.js 객체를 모듈 내부로 끌어오기
const Tone = window.Tone;

if (!Tone) {
  console.error("[audio] Tone.js가 로드되지 않았습니다. index.html 스크립트 순서를 확인하세요.");
}

/* ───────── L-System 樹木參數 ───────── */
const INITIAL_PLANT_COUNT = 18;
const MIN_SCALE_BY_CHAR = 3.4;
const RANDOM_SCALE_JITTER = [1.2, 2.2];
const AUTO_SPAWN_MAX = 60;
const AUTO_SPAWN_EVERY_N_TICKS = 3;
const INFINITE_GROW_INTERVAL_MS = 650;

/* ───────── three.js 基本設定 ───────── */
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
    if (!best || h.point.y > best.point.y) {
      best = { point: h.point.clone() };
    }
  }
  return best ? best.point : new THREE.Vector3(0, 0, 0);
}

/* ───────── 狀態 ───────── */
let terrainRoot = null;
let characterObjGroup = null;
const plants = [];
let infiniteGrowTimer = null;
let autoSpawnTick = 0;

/* ───────── GA 狀態 ───────── */
const GA_CONFIG = {
  populationSize: 40,
  survivalRate: SURVIVAL_RATE, // 0.4
  mutationRate: 0.15,
  crossoverRate: 0.9,
  // 這裡不再傳 slotPatternIds / lockPatternSlots
};

let ga = null;
let gaAutoRun = true;
let gaGenerationDuration = 10.0; // 秒
let gaTimer = 0;
let gaTransitioning = false;

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
    const prototypeNode = (characterObjGroup.children?.[0]) || characterObjGroup;

    /* 1) GA 初始化
       Gen0：ga.js 內部會把全部 patternId 設為 initialPatternId (預設 0) */
    ga = new GeneticAlgorithm({
      ...GA_CONFIG,
    });
    const initialPop = ga.initPopulation();

    /* 2) ThermoBug (Boids) 初始化 + 初始 Genome 反映 */
    initBoids({
      scene,
      camera,
      renderer,
      terrainRoot,
      prototypeNode,
      count: GA_CONFIG.populationSize,
      initialGenomes: initialPop,
    });

    /* 3) L-System 植物 */
    spawnPlantsOnTerrain({ count: INITIAL_PLANT_COUNT, oneOnPeak: true });
    plants.forEach((p) => p.update(0));

    /* 4) UI */
    setupUI();
    updateGAHud();

    /* 5) 啟動 Loop */
    update(0);

    /* 6) 設定「用點擊控制節奏」的音效：
       平常不出聲，只在點擊叫他們靠過來時發出水滴聲，
       點擊越快 → 聲音節奏越快、音色越緊張。 */
    setupAgentClickSoundRhythm();
  } catch (err) {
    console.error("[main] 初始化錯誤：", err);
  }
}
init();

/* ───────── L-System 樹木 ───────── */
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
  if (!terrainRoot) return;
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
      genMax: 4 + Math.floor(Math.random() * 2), // 4~5 層
      step: 0.8 + Math.random() * 0.25,
      baseRadius: 0.18 + Math.random() * 0.1,
      angleDeg: 22 + Math.random() * 18, // 每棵角度不同
      branchPerLevel: 3 + Math.floor(Math.random() * 3), // 3~5 根側枝
      leafClusterCount: 4 + Math.floor(Math.random() * 4), // 4~7 葉
      leafSize: 1.1 + Math.random() * 0.6,
      glowFactor: 0.8 + Math.random() * 0.6,
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
    if (typeof p.getGlowFactor === "function" && typeof p.setGlowFactor === "function") {
      const current = p.getGlowFactor();
      p.setGlowFactor(current * scale);
    }
  });
}

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

/* ───────── GA Loop 控制 ───────── */
function triggerNextGeneration() {
  if (!ga || gaTransitioning) return;

  gaTransitioning = true;
  gaTimer = 0;

  const { survivors, doomed } = ga.evaluatePopulation();
  markSelection(survivors, doomed, DEATH_ANIM_DURATION);

  const delay = (DEATH_ANIM_DURATION + SURVIVORS_WINDOW) * 1000;
  setTimeout(() => {
    if (!ga) {
      gaTransitioning = false;
      return;
    }
    const pop = ga.nextGeneration(doomed);
    applyPopulationGenomes(pop, doomed);
    markNewborn(doomed, NEWBORN_ANIM_DURATION);

    updateGAHud();
    gaTransitioning = false;
  }, delay);
}

function updateGAHud() {
  if (!ga) return;
  const genSpan = document.getElementById("ga-generation");
  if (genSpan) genSpan.textContent = `${ga.getGeneration()} 세대`;

  const sumSpan = document.getElementById("ga-pop-summary");
  if (sumSpan) {
    const pop = ga.getPopulation() || [];
    const patternCount = [0, 0, 0, 0, 0];
    let avgScale = 0;
    let avgSpeed = 0;

    pop.forEach((g) => {
      const pid = (g.patternId | 0) || 0;
      if (pid >= 0 && pid < patternCount.length) patternCount[pid]++;
      avgScale += g.bodyScale ?? 0;
      avgSpeed += g.baseSpeed ?? 0;
    });
    const n = pop.length || 1;
    avgScale /= n;
    avgSpeed /= n;

    sumSpan.textContent =
      `패턴分布 P0~P4: [${patternCount.join(", ")}], ` +
      `平均 몸집: ${avgScale.toFixed(2)}, ` +
      `平均 속度: ${avgSpeed.toFixed(2)}`;
  }
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
    case " ":
      plants.forEach((p) => p.togglePlay());
      break;
    case "[":
      plants.forEach((p) => p.addGen(-1));
      break;
    case "]":
    case "+":
    case "=":
      plants.forEach((p) => p.addGen(+1));
      break;

    // 樹的角度
    case "j":
    case "J":
      plants.forEach((p) => p.addAngle(-2));
      break;
    case "k":
    case "K":
      plants.forEach((p) => p.addAngle(+2));
      break;

    case "n":
    case "N":
      plants.forEach((p) => p.addDecay(+0.03));
      break;
    case "m":
    case "M":
      plants.forEach((p) => p.addDecay(-0.03));
      break;

    // 無限成長(G)
    case "g":
    case "G":
      toggleInfiniteGrow();
      break;

    // 🔅 變暗 / 🔆 變亮
    case "z":
    case "Z":
      changeGlowFactor(0.8);
      break;
    case "x":
    case "X":
      changeGlowFactor(1.25);
      break;

    // 手動下一代 (H)
    case "h":
    case "H":
      triggerNextGeneration();
      break;
  }
});

/* ───────── Loop ───────── */
const clock = new THREE.Clock();

function update(dt) {
  if (terrainRoot) updateTerrainTime(terrainRoot, dt);
  const tSec = performance.now() * 0.001;
  updateBoids(dt, tSec);
  plants.forEach((p) => p.update(dt));

  // GA auto-run
  if (ga && gaAutoRun && !gaTransitioning) {
    gaTimer += dt;
    if (gaTimer >= gaGenerationDuration) {
      gaTimer = 0;
      triggerNextGeneration();
    }
  }

  // ✅ 現在：update 裡面不自動出聲
  // 只有點擊時才會透過 setupAgentClickSoundRhythm() 觸發 playAgentSoundFromValue()
}

(function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  controls.update();
  composer.render();
})();

/* ───────── UI ───────── */
function setupUI() {
  // 植物無限成長控制
  const btn = document.getElementById("btn-grow");
  const stop = document.getElementById("btn-stop");
  btn?.addEventListener("click", () => toggleInfiniteGrow());
  stop?.addEventListener("click", () => stopInfiniteGrow());

  const dim = document.getElementById("btn-dim");
  const bright = document.getElementById("btn-bright");
  dim?.addEventListener("click", () => changeGlowFactor(0.8));
  bright?.addEventListener("click", () => changeGlowFactor(1.25));

  // GA 控制用:
  const btnNext = document.getElementById("ga-next");
  const chkAuto = document.getElementById("ga-auto");
  const sliderDur = document.getElementById("ga-duration");
  const durLabel = document.getElementById("ga-duration-label");

  btnNext?.addEventListener("click", () => {
    gaAutoRun = false;
    if (chkAuto) chkAuto.checked = false;
    triggerNextGeneration();
  });

  if (chkAuto) {
    chkAuto.checked = gaAutoRun;
    chkAuto.addEventListener("change", (e) => {
      gaAutoRun = !!e.target.checked;
    });
  }

  if (sliderDur) {
    sliderDur.value = String(gaGenerationDuration);
    const updateLabel = () => {
      if (durLabel) durLabel.textContent = `${sliderDur.value} s`;
    };
    updateLabel();
    sliderDur.addEventListener("input", () => {
      gaGenerationDuration = parseFloat(sliderDur.value) || 10;
      updateLabel();
    });
  }
}

/* ───────── 音效：speed → 水滴聲 ───────── */

/**
 * 這裡不再用「固定的物理 speed」，而是用「兩次點擊之間的時間間隔」來當作 speed。
 * 點擊越快 → 間隔越短 → 映射到越高的 value（0~5） → 聲音越高、越亮、越短。
 */
function playAgentSoundFromValue(value) {
  if (!Tone) return;

  // 確保在 0~5 之間
  const v = Math.max(0, Math.min(5, value));

  // 1) Pitch mapping: C6 ~ C7 附近的水滴感頻率
  const minFreq = 900;
  const maxFreq = 2000;
  const freq = minFreq + (maxFreq - minFreq) * (v / 5);

  // 2) 亮度：filter cutoff 跟著 speed 上升
  const cutoff = 800 + 2400 * (v / 5);

  // 3) 持續時間：速度越快越短
  const dur = 0.18 - 0.12 * (v / 5); // 0.18 → 0.06 秒

  const synth = new Tone.MembraneSynth({
    pitchDecay: 0.005,
    octaves: 2,
    envelope: {
      attack: 0.005,
      decay: dur,
      sustain: 0.0,
      release: 0.05,
    },
  });

  const filter = new Tone.Filter({
    type: "lowpass",
    frequency: cutoff,
    rolloff: -24,
  });

  synth.connect(filter).toDestination();

  const now = Tone.now();
  synth.triggerAttackRelease(freq, dur, now);
}

/* 
 * 點擊節奏 → 聲音節奏
 * - 不點擊：完全沒聲音
 * - 點擊一次：出現一顆水滴
 * - 點擊越快：因為間隔越短，所以映射的 value 越高 → 聲音越急促
 */
let audioReady = false;
let lastClickTime = null;

function setupAgentClickSoundRhythm() {
  if (!Tone) return;

  renderer.domElement.addEventListener("pointerdown", async () => {
    try {
      // 第一次點擊時解鎖 Audio Context
      if (!audioReady) {
        await Tone.start();
        await Tone.getContext().resume();
        audioReady = true;
      }

      const now = Tone.now();

      // 第一次點：沒有前一個時間，就給中間值 2.5
      let speedValue = 2.5;

      if (lastClickTime !== null) {
        const delta = now - lastClickTime; // 秒
        // 我們假設：0.1s 非常快點、1.2s 很慢點
        const MIN_DELTA = 0.1;
        const MAX_DELTA = 1.2;

        const clamped = Math.max(MIN_DELTA, Math.min(MAX_DELTA, delta));
        // clamped = MIN_DELTA → t = 0（超快） / clamped = MAX_DELTA → t = 1（很慢）
        const t = (clamped - MIN_DELTA) / (MAX_DELTA - MIN_DELTA);

        // t = 0 → value = 5（超快） / t = 1 → value = 0（慢）
        speedValue = (1 - t) * 5;
      }

      lastClickTime = now;

      // 用換算出來的「click speed」觸發水滴聲
      playAgentSoundFromValue(speedValue);
    } catch (err) {
      console.error("[audio] Tone.js 點擊音效啟動失敗：", err);
    }
  });
}

function setGrowButtonState(active) {
  const btn = document.getElementById("btn-grow");
  if (!btn) return;
  btn.textContent = active ? "⏸ 停止無限成長 (G)" : "▶ 無限成長 (G)";
}
