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
  const min = box.min, max = box.max;
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

/* ───────── GA 狀態 ───────── */
const GA_CONFIG = {
  populationSize: 40,
  survivalRate: SURVIVAL_RATE,
  mutationRate: 0.15,
  crossoverRate: 0.9,
};

let ga = null;
let gaAutoRun = true;
let gaGenerationDuration = 10.0;
let gaTimer = 0;
let gaTransitioning = false;

/* ─────────────────────────────────────────────────────────
   AUDIO STATE (放在 update() 之前，避免 TDZ)
───────────────────────────────────────────────────────── */
let audioReady = false;
let lastClickTime = null;

/* --- GA 平均 speed (0~5) --- */
function getAgentSpeedValueFromGA() {
  if (!ga || typeof ga.getPopulation !== "function") return 2.5;
  const pop = ga.getPopulation() || [];
  if (!pop.length) return 2.5;

  let sum = 0;
  for (const g of pop) sum += g.baseSpeed ?? 0;
  return THREE.MathUtils.clamp(sum / pop.length, 0, 5);
}

/* ───────── 音效：吸引生物用水滴聲（點擊節奏）───────── */
/** ⚠️ 完全不改 */
function playAgentSoundFromValue(value) {
  if (!Tone) return;

  const v = Math.max(0, Math.min(5, value));

  const minFreq = 900;
  const maxFreq = 2000;
  const freq = minFreq + (maxFreq - minFreq) * (v / 5);

  const cutoff = 800 + 2400 * (v / 5);

  const dur = 0.18 - 0.12 * (v / 5);

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
  synth.triggerAttackRelease(freq, dur, Tone.now());
}

/* ───────── 音效：踩草（生物移動）───────── */
let agentAmbientStarted = false;
let agentAmbientLoop = null;

function ensureAgentAmbientSound() {
  if (!Tone || agentAmbientStarted) return;
  agentAmbientStarted = true;

  const grassNoise = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.001, decay: 0.09, sustain: 0.0, release: 0.04 },
  });

  const hp = new Tone.Filter({ type: "highpass", frequency: 650, rolloff: -24 });
  const grassBP = new Tone.Filter({ type: "bandpass", frequency: 1600, Q: 1.8 });

  const stepThump = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 1.2,
    envelope: { attack: 0.001, decay: 0.07, sustain: 0.0, release: 0.02 },
  });

  const thumpLP = new Tone.Filter({ type: "lowpass", frequency: 280, rolloff: -24 });

  const reverb = new Tone.Reverb({ decay: 1.1, wet: 0.14 });

  const grassGain = new Tone.Gain(0.09);
  const thumpGain = new Tone.Gain(0.04);

  grassNoise.chain(hp, grassBP, grassGain, reverb, Tone.Destination);
  stepThump.chain(thumpLP, thumpGain, reverb);

  agentAmbientLoop = new Tone.Loop((time) => {
    const v = getAgentSpeedValueFromGA();

    const baseInterval = 1.05;
    const minInterval = 0.28;
    const interval = baseInterval - (baseInterval - minInterval) * (v / 5);
    agentAmbientLoop.interval = interval;

    grassBP.frequency.rampTo(1350 + 1500 * (v / 5), 0.12);
    grassGain.gain.rampTo(0.07 + 0.06 * (v / 5), 0.15);
    thumpGain.gain.rampTo(0.03 + 0.03 * (v / 5), 0.15);

    const steps = 2 + Math.floor(Math.random() * 3);
    const gap = interval / (steps * 2.0);

    for (let i = 0; i < steps; i++) {
      const t = time + i * gap + Math.random() * 0.02;
      grassNoise.triggerAttackRelease(0.035, t);

      const thumpFreq = 95 + 55 * (v / 5) + (Math.random() - 0.5) * 10;
      stepThump.triggerAttackRelease(thumpFreq, 0.05, t + 0.004);
    }
  }, 1.0);

  agentAmbientLoop.start(0);

  if (Tone.Transport.state !== "started") Tone.Transport.start();
}

/* ───────── 환경 기반 사운드: Gentle Forest Breeze (background) ───────── */
let windStarted = false;

// Tone nodes
let windNoise = null;
let windHP = null;
let windBP = null;
let windLP = null;
let windPan = null;
let windGain = null;
let windReverb = null;

// LFOs / schedulers
let windBreathLFO = null;     // 아주 느린 "호흡" (볼륨)
let windColorLFO = null;      // 아주 느린 "색" (필터)
let windPanLFO = null;        // 아주 느린 "방향"
let windGustLoop = null;      // 가끔 아주 살짝 불어오는 미풍
let windUpdateAcc = 0;

function ensureWindSound() {
  if (!Tone || windStarted) return;
  windStarted = true;

  // 1) 더 부드러운 바람: brown noise (핑크보다 더 '포근')
  windNoise = new Tone.Noise("brown");
  windNoise.start();

  // 2) 숲의 공기: 과한 고역/저역을 정리하고,
  //    중역(잎사귀 스침) 대역을 살짝 강조
  windHP = new Tone.Filter({ type: "highpass", frequency: 120, rolloff: -12 });
  windBP = new Tone.Filter({ type: "bandpass", frequency: 900, Q: 0.7 });
  windLP = new Tone.Filter({ type: "lowpass", frequency: 1800, rolloff: -12 });

  // 3) 아주 살짝 움직이는 방향감
  windPan = new Tone.Panner(0);

  // 4) 전체 볼륨: 더 작고 편안하게
  windGain = new Tone.Gain(0.008);

  // 5) 숲 공간감: 긴 리버브는 피하고, 맑고 얕게
  windReverb = new Tone.Reverb({ decay: 1.8, wet: 0.12 });

  windNoise.chain(windHP, windBP, windLP, windPan, windGain, windReverb, Tone.Destination);

  // ── LFO: "숨 쉬는" 느낌 (볼륨이 아주 천천히 오르내림)
  windBreathLFO = new Tone.LFO({
    frequency: 0.045, // 매우 느림
    min: 0.75,
    max: 1.10,
  }).start();
  windBreathLFO.connect(windGain.gain);

  // ── LFO: "공기 온도/향" 느낌 (필터가 아주 천천히 변함)
  windColorLFO = new Tone.LFO({
    frequency: 0.03,
    min: 850,
    max: 1450,
  }).start();
  windColorLFO.connect(windBP.frequency);

  // ── LFO: "바람 방향" (아주 천천히 좌우)
  windPanLFO = new Tone.LFO({
    frequency: 0.02,
    min: -0.35,
    max: 0.35,
  }).start();
  windPanLFO.connect(windPan.pan);

  // ── 아주 가끔 '미풍' (gust) : 세게 튀지 않게, 아주 조금만
  windGustLoop = new Tone.Loop((time) => {
    // 살짝만 볼륨/밝기 변화 (편안한 레벨)
    const gainNow = windGain.gain.value;
    windGain.gain.rampTo(Math.max(0.004, Math.min(0.02, gainNow * (0.92 + Math.random() * 0.14))), 2.2);

    const lpNow = windLP.frequency.value;
    windLP.frequency.rampTo(Math.max(1200, Math.min(2600, lpNow * (0.95 + Math.random() * 0.18))), 2.5);
  }, 6.0);
  windGustLoop.start(0);

  if (Tone.Transport.state !== "started") {
    Tone.Transport.start();
  }
}

/**
 * envValue(0~5): 생태계 활동/바람 세기처럼 사용
 * - 값이 커질수록: 조금 더 밝고(필터), 약간 더 존재감(볼륨), gust 더 잦음
 * - 변화는 전부 rampTo로 "부드럽게"
 */
function updateEnvironmentSound(envValue, dt = 0.016) {
  if (!Tone || !windStarted) return;

  // 너무 자주 만지면 지저분해질 수 있으니 약간만 절제
  windUpdateAcc += dt;
  if (windUpdateAcc < 0.18) return;
  windUpdateAcc = 0;

  const v = THREE.MathUtils.clamp(envValue ?? 2.5, 0, 5);
  const t = v / 5;

  // ✅ 전체 볼륨: 더 편안한 범위
  // (바람 존재감은 있지만 "배경"으로 남게)
  const baseGain = 0.006 + 0.010 * t; // 0.006~0.016
  windGain.gain.rampTo(baseGain, 1.0);

  // ✅ 바람의 "맑음/청량": 너무 날카롭지 않게 상한 제한
  const lpCut = 1500 + 900 * t; // 1500~2400
  windLP.frequency.rampTo(lpCut, 1.2);

  // ✅ 잎사귀 대역(밴드패스): 조금만 위로
  const bpCut = 800 + 400 * t; // 800~1200
  windBP.frequency.rampTo(bpCut, 1.4);

  // ✅ "호흡" 속도: 활동적일수록 조금 더 빠르게 (그래도 느리게)
  const breathRate = 0.035 + 0.035 * t; // 0.035~0.07
  windBreathLFO.frequency.rampTo(breathRate, 2.0);

  // ✅ gust 간격: 바빠질수록 조금 더 자주
  windGustLoop.interval = 7.5 - 2.5 * t; // 7.5~5.0
}


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

    ga = new GeneticAlgorithm({ ...GA_CONFIG });
    const initialPop = ga.initPopulation();

    initBoids({
      scene,
      camera,
      renderer,
      terrainRoot,
      prototypeNode,
      count: GA_CONFIG.populationSize,
      initialGenomes: initialPop,
    });

    spawnPlantsOnTerrain({ count: INITIAL_PLANT_COUNT, oneOnPeak: true });
    plants.forEach((p) => p.update(0));

    setupUI();
    updateGAHud();

    update(0);
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
  s *= THREE.MathUtils.lerp(RANDOM_SCALE_JITTER[0], RANDOM_SCALE_JITTER[1], Math.random());
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
      genMax: 4 + Math.floor(Math.random() * 2),
      step: 0.8 + Math.random() * 0.25,
      baseRadius: 0.18 + Math.random() * 0.1,
      angleDeg: 22 + Math.random() * 18,
      branchPerLevel: 3 + Math.floor(Math.random() * 3),
      leafClusterCount: 4 + Math.floor(Math.random() * 4),
      leafSize: 1.1 + Math.random() * 0.6,
      glowFactor: 0.8 + Math.random() * 0.6,
    });
    plant.object3d.position.copy(pos);
    scene.add(plant.object3d);
    scalePlantByCharacter(plant);
    plants.push(plant);
  }
}

/* 無限成長 */
function startInfiniteGrow(ms = INFINITE_GROW_INTERVAL_MS) {
  if (infiniteGrowTimer) return;
  infiniteGrowTimer = setInterval(() => {
    plants.forEach((p) => p.addGen(+1));
    autoSpawnTick++;
    if (autoSpawnTick % AUTO_SPAWN_EVERY_N_TICKS === 0 && plants.length < AUTO_SPAWN_MAX) {
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

/* GA Loop */
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

/* resize */
window.addEventListener("resize", () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

/* key */
window.addEventListener("keydown", (e) => {
  switch (e.key) {
    case "g":
    case "G":
      toggleInfiniteGrow();
      break;
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

  if (ga && gaAutoRun && !gaTransitioning) {
    gaTimer += dt;
    if (gaTimer >= gaGenerationDuration) {
      gaTimer = 0;
      triggerNextGeneration();
    }
  }

  // ✅ 重要：只有「音訊已解鎖」才更新風聲（避免任何初始化順序問題）
  if (audioReady) {
    updateEnvironmentSound(getAgentSpeedValueFromGA(), dt);
  }
}

(function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  controls.update();
  composer.render();
})();

/* UI */
function setupUI() {
  const btn = document.getElementById("btn-grow");
  const stop = document.getElementById("btn-stop");
  btn?.addEventListener("click", () => toggleInfiniteGrow());
  stop?.addEventListener("click", () => stopInfiniteGrow());
}

function setGrowButtonState(active) {
  const btn = document.getElementById("btn-grow");
  if (!btn) return;
  btn.textContent = active ? "⏸ 停止無限成長 (G)" : "▶ 無限成長 (G)";
}

/* 點擊解鎖音訊 + 水滴 + 啟動踩草 + 啟動風聲 */
function setupAgentClickSoundRhythm() {
  if (!Tone) return;

  renderer.domElement.addEventListener("pointerdown", async () => {
    try {
      if (!audioReady) {
        await Tone.start();
        await Tone.getContext().resume();
        audioReady = true;

        ensureAgentAmbientSound();
        ensureWindSound();
      }

      const now = Tone.now();
      let speedValue = 2.5;

      if (lastClickTime !== null) {
        const delta = now - lastClickTime;
        const MIN_DELTA = 0.1;
        const MAX_DELTA = 1.2;

        const clamped = Math.max(MIN_DELTA, Math.min(MAX_DELTA, delta));
        const t = (clamped - MIN_DELTA) / (MAX_DELTA - MIN_DELTA);
        speedValue = (1 - t) * 5;
      }

      lastClickTime = now;

      // ✅ 點擊水滴聲：不改
      playAgentSoundFromValue(speedValue);
    } catch (err) {
      console.error("[audio] Tone.js 點擊音效啟動失敗：", err);
    }
  });
}