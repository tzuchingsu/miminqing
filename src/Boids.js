// src/Boids.js
import * as THREE from "three";

/* ========================
 * RD 패턴 텍스처 파일
 * ======================== */
export const RD_TEXTURE_PATHS = [
  "./assets/textures/RD.png",   // patternId 0
  "./assets/textures/RD1.png",  // patternId 1
  "./assets/textures/RD2.png",  // patternId 2
  "./assets/textures/RD3.png",  // patternId 3
  "./assets/textures/RD4.png",  // patternId 4
];

const rdLoader = new THREE.TextureLoader();
const rdTextures = RD_TEXTURE_PATHS.map((path) => rdLoader.load(path));

/* ========================
 * GA Survival 可視化用 상수
 * ======================== */
export const SURVIVAL_RATE = 0.4;
export const DEATH_ANIM_DURATION = 2.0;
export const SURVIVORS_WINDOW = 1.0;
export const NEWBORN_ANIM_DURATION = 1.0;

/* ========================
 * 可調參數
 * ======================== */
const PARAM = {
  COUNT: 20,

  // 群內距離（越大越不擠）
  NEIGHBOR_R: 4.0,
  SEP_R: 2.0,
  SEPARATE_W: 1.7,
  ALIGN_W: 0.36,
  COHERE_W: 0.24,

  // 動力學
  MAX_SPEED: 4.2,
  STEER_MAX: 8.0,
  DAMPING: 0.88,

  // 熱源吸引
  SEEK_GAIN: 6.2,
  SUN_PULL: 6.0,
  FAR_ACCEL_INNER: 4.0,
  FAR_ACCEL_OUTER: 14.0,
  REPEL_GAIN: 3.8,

  // 姿態/貼地/跳動
  YAW_LERP: 8.0,
  FOOT_OFFSET: 0.06,
  SLOPE_ALIGN: 0.92,
  HOP_AMP: 0.22,
  HOP_FREQ_BASE: 2.0,
  HOP_FREQ_FARBOOST: 1.8,

  // 紅光門檻
  GLOW_INNER: 1.2,
  GLOW_OUTER: 5.8,

  // 過熱判定
  OVERHEAT_TEMP: 0.90,
  OVERHEAT_PULSE: 0.6,

  // 安全貼地
  MAX_HOVER: 1.0,
};

// ───────────────────────────────
// Slime Mold Sensing / Trail
// ───────────────────────────────
const BOUND_RADIUS = 100;

const SENSOR_DISTANCE = 12;
const SENSOR_ANGLE = Math.PI / 4;

const TRAIL_GRID_SIZE = 128;
const TRAIL_CELL_SIZE = (BOUND_RADIUS * 2) / TRAIL_GRID_SIZE;

const TRAIL_DEPOSIT_AMOUNT = 3.0;
const TRAIL_DECAY_RATE = 0.96;
const W_TRAIL_FOLLOW = 1.5;

let trailGrid = new Float32Array(TRAIL_GRID_SIZE * TRAIL_GRID_SIZE);

let trailTexture = null;
let trailTextureData = null;
let trailMesh = null;

/* ========================
 * 內部狀態
 * ======================== */
let scene, camera, renderer;
let terrainRoot, sampler;
let protoNode;
let agents = [];
let heatGroup;
let raycaster;

const Field = {
  sun: { pos: new THREE.Vector2(0, 0), baseI: 4.8, spread: 12.0, heatPulse: 0.0 },
  D: 0.8,
  eps: 1e-3,
  emitters: [],
};

/* ========================
 * 營養源場 (Nutrient field)
 * ======================== */

// 內部營養源儲存陣列（力場用）
const nutrientPoints = [];

// 額外：營養源視覺物件
let nutrientObjects = []; // { mesh, pos, active, pulsePhase }

// 近距離作用範圍（力場）
const NUTRIENT_INNER_R = 1.0;
const NUTRIENT_OUTER_R = 6.0;

// 生物「吃到」營養源的碰撞半徑
const NUTRIENT_ABSORB_RADIUS = 1.2;

// 場上營養源數量
const NUTRIENT_COUNT = 32;

export function setNutrientPoints(points) {
  nutrientPoints.length = 0;
  for (const p of points) {
    if (!p) continue;
    if (p.isVector3) {
      nutrientPoints.push(p.clone());
    } else {
      nutrientPoints.push(
        new THREE.Vector3(p.x, p.y ?? 0, p.z)
      );
    }
  }
}

export function addNutrientPoint(x, y, z) {
  nutrientPoints.push(new THREE.Vector3(x, y, z));
}

function getNutrientForce(pos) {
  const dir = new THREE.Vector3(0, 0, 0);
  if (!nutrientPoints.length) return dir;

  for (const n of nutrientPoints) {
    const dx = n.x - pos.x;
    const dz = n.z - pos.z;
    const d2 = dx * dx + dz * dz;

    const rOut2 = NUTRIENT_OUTER_R * NUTRIENT_OUTER_R;
    if (d2 <= 1e-6 || d2 > rOut2) continue;

    const d = Math.sqrt(d2);
    const w = THREE.MathUtils.smoothstep(
      d,
      NUTRIENT_OUTER_R,
      NUTRIENT_INNER_R
    );
    if (w <= 0) continue;

    dir.x += (dx / d) * w;
    dir.z += (dz / d) * w;
  }

  if (dir.lengthSq() < 1e-6) {
    dir.set(0, 0, 0);
    return dir;
  }
  dir.normalize();
  return dir;
}

// 點擊後「驚嚇」窗口
const Panic = { activeUntil: 0, radiusMul: 1.15 };

// Life state
const LIFE = {
  ALIVE: "alive",
  DYING: "dying",
  DEAD: "dead",
  NEWBORN: "newborn",
};

/* ========================
 * 공용 유틸
 * ======================== */
function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
function angleDiff(a, b) {
  const d = b - a;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
function yawTowards(currYaw, vx, vz, dt) {
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-3) return currYaw;
  const target = Math.atan2(vx, vz);
  const d = angleDiff(currYaw, target);
  const rate = 1.0 - Math.exp(-PARAM.YAW_LERP * dt);
  return currYaw + d * rate;
}

/* HSV → THREE.Color */
function hsvToRgb(hDeg, s, v) {
  const h = ((hDeg % 360) + 360) % 360 / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return new THREE.Color(r, g, b);
}

/* ========================
 * 熱場取樣
 * ======================== */
function addEmitter(x, z, { intensity = 6.0, spread = 1.2, decayRate = 1.0 } = {}) {
  Field.emitters.push({
    pos: new THREE.Vector2(x, z),
    I0: intensity,
    spread0: spread,
    birth: performance.now() * 0.001,
    decay: decayRate,
  });
}

function sampleField(x, z, tSec) {
  let rho = 0,
    gx = 0,
    gz = 0,
    rhoSun = 0,
    gxSun = 0,
    gzSun = 0;

  // 主熱源
  {
    const I = Field.sun.baseI + Field.sun.heatPulse;
    const sigma2 = Field.sun.spread * Field.sun.spread;
    const dx = x - Field.sun.pos.x;
    const dz = z - Field.sun.pos.y;
    const r2 = dx * dx + dz * dz;
    const G = I * Math.exp(-r2 / (2 * sigma2));
    rho += G;
    rhoSun += G;

    const inv = 1 / sigma2;
    const gxP = G * (-dx * inv);
    const gzP = G * (-dz * inv);
    gx += gxP;
    gz += gzP;
    gxSun += gxP;
    gzSun += gzP;
  }

  const now = tSec;
  const survivors = [];
  for (const e of Field.emitters) {
    const age = Math.max(0, now - e.birth);
    const I = e.I0 * Math.exp(-e.decay * age);
    if (I < Field.eps) continue;
    survivors.push(e);

    const sigma2 = e.spread0 * e.spread0 + 2 * Field.D * age;
    const dx = x - e.pos.x;
    const dz = z - e.pos.y;
    const r2 = dx * dx + dz * dz;
    const G = I * Math.exp(-r2 / (2 * sigma2));
    rho += G;

    const inv = 1 / sigma2;
    gx += G * (-dx * inv);
    gz += G * (-dz * inv);
  }
  Field.emitters = survivors;

  return { rho, gradX: gx, gradZ: gz, rhoSun, gradSunX: gxSun, gradSunZ: gzSun };
}

/* ========================
 * 熱圈可視化
 * ======================== */
function makeHeatVisual() {
  const group = new THREE.Group();
  group.renderOrder = 9999;

  const ring = (inner, outer, col, op) => {
    const geo = new THREE.RingGeometry(inner, outer, 128);
    const mat = new THREE.MeshBasicMaterial({
      color: col,
      transparent: true,
      opacity: op,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI * 0.5;
    return m;
  };
  const ringOuter = ring(0.965, 1.0, new THREE.Color(1.0, 0.85, 0.35), 0.34);
  const ringInner = ring(0.82, 0.9, new THREE.Color(1.0, 0.97, 0.9), 0.28);
  group.add(ringOuter, ringInner);

  group.userData.update = () => {
    const pulse = THREE.MathUtils.clamp(Field.sun.heatPulse, 0, 3);
    const baseR = 6.0 * (0.78 + 0.22 * pulse);
    ringOuter.scale.set(baseR, baseR, 1);
    ringInner.scale.set(baseR, baseR, 1);
    group.userData.visualRadius = baseR;
  };

  return group;
}

// ───────────────────────────────
// Sensing force 함수
// ───────────────────────────────
const _yAxis = new THREE.Vector3(0, 1, 0);
const _tmpDir = new THREE.Vector3();
const _tmpLeftDir = new THREE.Vector3();
const _tmpRightDir = new THREE.Vector3();

const TRAIL_MAX_POINTS = 220;

function applyTrailSensingForce(agentIndex, accOut) {
  const pos = boidPositions[agentIndex];
  const vel = boidVelocities[agentIndex];

  if (vel.lengthSq() < 1e-6) return;

  _tmpDir.copy(vel).normalize();

  _tmpLeftDir.copy(_tmpDir).applyAxisAngle(_yAxis, +SENSOR_ANGLE);
  _tmpRightDir.copy(_tmpDir).applyAxisAngle(_yAxis, -SENSOR_ANGLE);

  const fx = pos.x + _tmpDir.x * SENSOR_DISTANCE;
  const fz = pos.z + _tmpDir.z * SENSOR_DISTANCE;

  const lx = pos.x + _tmpLeftDir.x * SENSOR_DISTANCE;
  const lz = pos.z + _tmpLeftDir.z * SENSOR_DISTANCE;

  const rx = pos.x + _tmpRightDir.x * SENSOR_DISTANCE;
  const rz = pos.z + _tmpRightDir.z * SENSOR_DISTANCE;

  const valF = sampleTrail(fx, fz);
  const valL = sampleTrail(lx, lz);
  const valR = sampleTrail(rx, rz);

  let bestDir = _tmpDir;
  let bestVal = valF;

  if (valL > bestVal) {
    bestVal = valL;
    bestDir = _tmpLeftDir;
  }
  if (valR > bestVal) {
    bestVal = valR;
    bestDir = _tmpRightDir;
  }

  if (bestVal <= 0.001) return;

  accOut.addScaledVector(bestDir, W_TRAIL_FOLLOW * bestVal);
}

/* ========================
 * 發光控制 (per object uGlow)
 * ======================== */
function enablePerObjectGlow(node) {
  const mats = [];
  node.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => m.clone())
      : o.material.clone();
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    arr.forEach((m) => {
      if ("emissive" in m) m.emissive.setRGB(0, 0, 0);
      if ("emissiveIntensity" in m) m.emissiveIntensity = 0.02;

      m.userData.uGlow = { value: 0.0 };
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uGlow = m.userData.uGlow;
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `
#include <common>
uniform float uGlow;`
          )
          .replace(
            "#include <emissivemap_fragment>",
            `
#include <emissivemap_fragment>
totalEmissiveRadiance *= 0.02;
vec3 heatColor = vec3(1.0, 0.12, 0.0);
totalEmissiveRadiance += heatColor * (1.10 * uGlow);
`
          );
      };
      m.needsUpdate = true;
      mats.push(m);
    });
  });
  return (g) => {
    const v = clamp(g, 0, 1);
    mats.forEach((m) => {
      if (m.userData?.uGlow) m.userData.uGlow.value = v;
    });
  };
}

/* ========================
 * GA: Genome → Boid 적용
 * ======================== */

export function applyGenomeToBoid(index, genome) {
  const a = agents[index];
  if (!a) return;

  a.genome = genome;

  // 1) 패턴 텍스처
  const pid = clamp(genome.patternId | 0, 0, rdTextures.length - 1);
  const tex = rdTextures[pid];
  a.obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      m.map = tex;
      m.needsUpdate = true;
    });
  });

  // 2) 색상（身體）
  const hue = genome.hue ?? 220;
  const value = genome.value ?? 0.8;
  const showOff = genome.showOff ?? 0.5;
  const sat = THREE.MathUtils.clamp(0.3 + showOff * 0.6, 0.0, 1.0);
  const col = hsvToRgb(hue, sat, value);

  a.obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if ("color" in m) m.color.copy(col);
    });
  });

  // 2.5) 線條顏色：根據 body 顏色調亮，保持同一色系
  if (!a.trailColor) {
    a.trailColor = new THREE.Color(1.0, 0.7, 0.2);
  }

  const hsl = { h: 0, s: 0, l: 0 };
  col.getHSL(hsl);

  // 線條比身體稍微更飽和、亮一點，讓路徑更顯眼
  const lineS = THREE.MathUtils.clamp(hsl.s + 0.2, 0.0, 1.0);
  const lineL = THREE.MathUtils.clamp(0.55 + 0.25 * (showOff ?? 0.5), 0.0, 1.0);

  const lineColor = new THREE.Color().setHSL(hsl.h, lineS, lineL);
  a.trailColor.copy(lineColor);

  if (a.trailLine && a.trailLine.material) {
    a.trailLine.material.color.copy(lineColor);
    a.trailLine.material.needsUpdate = true;
  }

  // 3) 스케일
  const scale = genome.bodyScale ?? 1.0;
  a.baseScale = scale;
  // 實際縮放在 update 內再乘上 lifeScale / trailScale

  // 4) 움직임 파라미터
  a.speedFactor = genome.baseSpeed ?? 1.0;
  a.showOff = showOff;
}

export function applyPopulationGenomes(population, indices = null) {
  if (!population || !population.length) return;

  if (!indices || !indices.length) {
    const n = Math.min(population.length, agents.length);
    for (let i = 0; i < n; i++) applyGenomeToBoid(i, population[i]);
  } else {
    for (const idx of indices) {
      if (idx >= 0 && idx < population.length) {
        applyGenomeToBoid(idx, population[idx]);
      }
    }
  }
}

/* ========================
 * Trail grid 헬퍼
 * ======================== */
function worldToTrailIndex(x, z) {
  const u = (x + BOUND_RADIUS) / (BOUND_RADIUS * 2);
  const v = (z + BOUND_RADIUS) / (BOUND_RADIUS * 2);

  const ix = Math.floor(
    THREE.MathUtils.clamp(u, 0, 0.999) * TRAIL_GRID_SIZE
  );
  const iz = Math.floor(
    THREE.MathUtils.clamp(v, 0, 0.999) * TRAIL_GRID_SIZE
  );

  return ix + iz * TRAIL_GRID_SIZE;
}

function sampleTrail(x, z) {
  const idx = worldToTrailIndex(x, z);
  return trailGrid[idx];
}

function getTrailStrengthAt(pos) {
  const value = sampleTrail(pos.x, pos.z);
  const MAX_VIS_VALUE = 1.5;
  let t = value / MAX_VIS_VALUE;
  if (t > 1) t = 1;
  if (t < 0) t = 0;
  return t;
}

function decayTrail() {
  for (let i = 0; i < trailGrid.length; i++) {
    trailGrid[i] *= TRAIL_DECAY_RATE;
  }
}

function updateTrailTexture() {
  if (!trailTexture || !trailTextureData) return;

  const MAX_VIS_VALUE = 1.5;
  for (let i = 0; i < trailGrid.length; i++) {
    let t = trailGrid[i] / MAX_VIS_VALUE;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    trailTextureData[i] = Math.floor(t * 255);
  }
  trailTexture.needsUpdate = true;
}

function depositTrail(x, z, amount = TRAIL_DEPOSIT_AMOUNT) {
  const idx = worldToTrailIndex(x, z);
  trailGrid[idx] += amount;
}

/* ========================
 * 營養源：小太陽 Mesh 生成與管理
 * ======================== */

// 在地形上某個 XZ 生成一顆發光小太陽
function spawnNutrientAt(x, z) {
  if (!scene) return null;

  let p;
  if (sampler) {
    const hit = sampler(x, z);
    p = hit.point.clone();
    p.y += 0.35;
  } else {
    p = new THREE.Vector3(x, 0.35, z);
  }

  const sphereGeo = new THREE.SphereGeometry(0.35, 16, 16);
  const sphereMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(1.0, 0.9, 0.4),
    emissive: new THREE.Color(1.0, 0.7, 0.15),
    emissiveIntensity: 2.7,
    metalness: 0.0,
    roughness: 0.25,
  });

  const core = new THREE.Mesh(sphereGeo, sphereMat);

  // 小太陽外側淡淡光暈
  const haloGeo = new THREE.RingGeometry(0.5, 0.9, 32);
  const haloMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.85, 0.3),
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.rotation.x = -Math.PI * 0.5;

  const group = new THREE.Group();
  group.add(core);
  group.add(halo);
  group.position.copy(p);
  group.castShadow = false;
  group.receiveShadow = false;
  scene.add(group);

  nutrientObjects.push({
    mesh: group,
    pos: p.clone(),
    active: true,
    pulsePhase: Math.random() * Math.PI * 2
  });

  // 讓力場也感受到這顆營養源
  addNutrientPoint(p.x, p.y, p.z);

  return group;
}

// 在地形上隨機散佈多顆營養源
function scatterNutrients() {
  if (!terrainRoot) return;
  nutrientObjects.forEach((n) => {
    if (n.mesh && n.mesh.parent) n.mesh.parent.remove(n.mesh);
  });
  nutrientObjects = [];
  nutrientPoints.length = 0;

  const size = terrainRoot?.userData?.size ?? (BOUND_RADIUS * 2);
  const maxR = Math.min(size * 0.45, BOUND_RADIUS * 0.85);

  for (let i = 0; i < NUTRIENT_COUNT; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * maxR;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    spawnNutrientAt(x, z);
  }
}

// 生物碰到營養源 → 吸收
function tryAbsorbNutrients(agent) {
  if (!nutrientObjects.length) return;

  for (let i = 0; i < nutrientObjects.length; i++) {
    const n = nutrientObjects[i];
    if (!n.active) continue;

    const dx = n.pos.x - agent.pos.x;
    const dz = n.pos.z - agent.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > NUTRIENT_ABSORB_RADIUS * NUTRIENT_ABSORB_RADIUS) continue;

    // 被吃掉
    n.active = false;
    if (n.mesh && n.mesh.parent) {
      n.mesh.parent.remove(n.mesh);
    }

    // 從 nutrientPoints 中移除對應點（簡單依距離找最近的）
    let bestK = -1;
    let bestDist = 1e9;
    for (let k = 0; k < nutrientPoints.length; k++) {
      const p = nutrientPoints[k];
      const dx2 = p.x - n.pos.x;
      const dz2 = p.z - n.pos.z;
      const d22 = dx2 * dx2 + dz2 * dz2;
      if (d22 < bestDist) {
        bestDist = d22;
        bestK = k;
      }
    }
    if (bestK >= 0) {
      nutrientPoints.splice(bestK, 1);
    }

    // 生物獲得能量加成
    agent.nutrientBoostTimer = (agent.nutrientBoostTimer || 0) + 2.0;

    // 吃到的一瞬間補一點光脈衝
    Field.sun.heatPulse += 0.1;

    // 一隻生物同一時間吃一個就好
    break;
  }
}

/* ========================
 * 初始化
 * ======================== */

export function initBoids({
  scene: _scene,
  camera: _camera,
  renderer: _renderer,
  terrainRoot: _terrainRoot,
  prototypeNode,
  count = 20,
  initialGenomes = null,
}) {
  scene = _scene;
  camera = _camera;
  renderer = _renderer;
  terrainRoot = _terrainRoot;
  protoNode = prototypeNode;
  PARAM.COUNT = count | 0;

  sampler = terrainRoot?.userData?.heightSamplerWorld || null;
  if (!sampler) {
    console.warn("[Boids] heightSamplerWorld 未提供，會退回 y=0 & up=(0,1,0)");
  }

  // 熱圈
  heatGroup = makeHeatVisual();
  scene.add(heatGroup);

  {
    // DataTexture 用的 Uint8 灰階資料
    trailTextureData = new Uint8Array(TRAIL_GRID_SIZE * TRAIL_GRID_SIZE);

    trailTexture = new THREE.DataTexture(
      trailTextureData,
      TRAIL_GRID_SIZE,
      TRAIL_GRID_SIZE,
      THREE.LuminanceFormat
    );
    trailTexture.minFilter = THREE.LinearFilter;
    trailTexture.magFilter = THREE.LinearFilter;
    trailTexture.wrapS = THREE.ClampToEdgeWrapping;
    trailTexture.wrapT = THREE.ClampToEdgeWrapping;
    trailTexture.needsUpdate = true;

    const trailMat = new THREE.MeshBasicMaterial({
      map: trailTexture,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    const planeGeo = new THREE.PlaneGeometry(BOUND_RADIUS * 2, BOUND_RADIUS * 2);
    trailMesh = new THREE.Mesh(planeGeo, trailMat);
    trailMesh.rotation.x = -Math.PI * 0.5;
    trailMesh.position.set(0, 0.05, 0);
    scene.add(trailMesh);
  }

  // 生成 (Poisson-like)
  const size = terrainRoot?.userData?.size ?? 200;
  const spawnR = Math.min(16, size * 0.25);
  const used = [];
  agents = [];

  for (let i = 0; i < PARAM.COUNT; i++) {
    let p, ok = false, tries = 0;
    while (!ok && tries < 240) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spawnR;
      p = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
      ok = used.every((q) => p.distanceTo(q) > PARAM.SEP_R * 2.0);
      tries++;
    }
    used.push(p.clone());

    if (sampler) {
      const hit = sampler(p.x, p.z);
      p.set(hit.point.x, hit.point.y + PARAM.FOOT_OFFSET, hit.point.z);
    } else {
      p.y = PARAM.FOOT_OFFSET;
    }

    const inst = protoNode.clone(true);

    // 初始大小（之後會再被 baseScale/state 調整）
    inst.scale.setScalar(7.0);

    inst.name = `ThermoBug_${i}`;
    inst.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = false;
    });
    const setGlow = enablePerObjectGlow(inst);
    scene.add(inst);

    const vel = new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
    const yaw = Math.random() * Math.PI * 2;
    const hopPhase = Math.random() * Math.PI * 2;

    // trail Line
    const trailGeo = new THREE.BufferGeometry().setFromPoints([
      p.clone(), p.clone()
    ]);

    const trailLineMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(1.0, 0.7, 0.2), // 先隨便給，之後 applyGenomeToBoid 會根據顏色改掉
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    const trailLine = new THREE.Line(trailGeo, trailLineMat);
    trailLine.position.set(0, 0.02, 0);
    scene.add(trailLine);

    const agent = {
      obj: inst,
      pos: p.clone(),
      vel,
      yaw,
      hopPhase,
      setGlow,
      _noise: Math.random() * 1000,
      genome: null,
      speedFactor: 1.0,
      showOff: 0.5,
      baseScale: 1.0,
      // life state
      state: LIFE.ALIVE,
      deathT: 0,
      newbornT: 0,
      lifeScale: 1.0,
      lifeVisibility: 1.0,
      // trail 可視化
      trailPoints: [p.clone()],
      trailLine,
      trailColor: new THREE.Color(1.0, 0.7, 0.2),
      // 營養加成計時
      nutrientBoostTimer: 0.0,
    };

    agents.push(agent);
  }

  // 初始 Genome
  if (initialGenomes && initialGenomes.length) {
    applyPopulationGenomes(initialGenomes);
  }

  // 在地形上放置營養源
  scatterNutrients();

  // pointer→XZ
  raycaster = new THREE.Raycaster();
  const TERRAIN_TARGETS = [];
  if (terrainRoot?.userData?.collider?.isMesh)
    TERRAIN_TARGETS.push(terrainRoot.userData.collider);
  terrainRoot.traverse((o) => {
    if (o?.isMesh && !TERRAIN_TARGETS.includes(o)) TERRAIN_TARGETS.push(o);
  });

  function pointerToXZ(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const mouseX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const mouseY = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera({ x: mouseX, y: mouseY }, camera);
    const hit = raycaster.intersectObjects(TERRAIN_TARGETS, false)[0];
    if (hit) {
      Field.sun.pos.set(hit.point.x, hit.point.z);
    }
  }

  renderer.domElement.addEventListener("pointermove", pointerToXZ, { passive: true });
  renderer.domElement.addEventListener(
    "click",
    (ev) => {
      pointerToXZ(ev);
      addEmitter(Field.sun.pos.x, Field.sun.pos.y);
      Field.sun.heatPulse += 0.9;
      Panic.activeUntil = performance.now() * 0.001 + 0.9;
    },
    { passive: true }
  );
}

/* ========================
 * GA Selection 可視化
 * ======================== */

export function markSelection(survivorIndices, doomedIndices, deathDuration = DEATH_ANIM_DURATION) {
  // 生還者：如果原本 DEAD，就讓他重新活過來（含 trail）
  for (const idx of survivorIndices) {
    const a = agents[idx];
    if (!a) continue;
    if (a.state === LIFE.DEAD) {
      a.state = LIFE.ALIVE;
      a.deathT = 0;
      a.newbornT = 0;
      a.lifeScale = 1.0;
      a.lifeVisibility = 1.0;
      a.obj.visible = true;
      if (a.trailLine) {
        a.trailLine.visible = true;
        if (a.trailPoints && a.trailPoints.length === 0) {
          a.trailPoints.push(a.pos.clone());
        }
      }
    }
  }

  // 淘汰者：進入 DYING 狀態，開始慢慢縮小＋淡出
  for (const idx of doomedIndices) {
    const a = agents[idx];
    if (!a) continue;
    a.state = LIFE.DYING;
    a.deathT = 0;
    a.lifeScale = 1.0;
    a.lifeVisibility = 1.0;
    a.obj.visible = true;
    if (a.trailLine) a.trailLine.visible = true;
  }
}

export function markNewborn(indices, duration = NEWBORN_ANIM_DURATION) {
  for (const idx of indices) {
    const a = agents[idx];
    if (!a) continue;
    a.state = LIFE.NEWBORN;
    a.newbornT = 0;
    a.deathT = 0;
    a.lifeScale = 0.0;
    a.lifeVisibility = 0.0;

    // 一開始幾乎看不到，慢慢長大
    a.obj.visible = true;
    a.obj.scale.setScalar(0.001);

    // Trail 重新開始：先清掉舊的點，從目前位置慢慢畫
    if (a.trailPoints) {
      a.trailPoints.length = 0;
      a.trailPoints.push(a.pos.clone());
    }
    if (a.trailLine) {
      a.trailLine.visible = true;
      const m = a.trailLine.material;
      m.opacity = 0.0;
      m.needsUpdate = true;
    }
  }
}

/* ========================
 * 每幀更新
 * ======================== */

const _tmp = new THREE.Vector3();

export function updateBoids(dt, tSec) {
  // 0) trail 整體衰減
  decayTrail();

  if (!agents.length) return;

  // 0.5) 更新營養源視覺：輕微呼吸 & 跳動
  for (const n of nutrientObjects) {
    if (!n.active || !n.mesh) continue;
    n.pulsePhase += dt * 2.4;
    const puls = 0.7 + 0.3 * Math.sin(n.pulsePhase);
    const hop = 0.05 * Math.sin(n.pulsePhase * 1.7);

    n.mesh.scale.setScalar(puls);
    n.mesh.position.y = n.pos.y + hop;
  }

  // 熱圈位置 / 半徑
  const groundAtSun = sampler ? sampler(Field.sun.pos.x, Field.sun.pos.y).point.y : 0;
  heatGroup.position.set(Field.sun.pos.x, groundAtSun + 0.01, Field.sun.pos.y);
  heatGroup.userData.update?.();
  const visualR = heatGroup.userData.visualRadius || 6.0;

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

    // DEAD：完全看不到本體與線
    if (a.state === LIFE.DEAD) {
      a.obj.visible = false;
      if (a.trailLine) a.trailLine.visible = false;
      continue;
    }

    a.obj.visible = true;
    if (a.trailLine) a.trailLine.visible = true;

    // nutrient boost 計時
    if (a.nutrientBoostTimer > 0) {
      a.nutrientBoostTimer = Math.max(0, a.nutrientBoostTimer - dt);
    }
    const nutrientBoost = clamp(a.nutrientBoostTimer / 2.0, 0.0, 1.0); // 0~1

    // lifeScale / lifeVisibility: 0~1 決定「有多活著」
    let lifeScale = 1.0;
    let lifeVisibility = 1.0;

    // 1) Life state 애니메이션
    if (a.state === LIFE.DYING) {
      a.deathT += dt;
      const t = clamp(a.deathT / DEATH_ANIM_DURATION, 0, 1);
      const fade = 1.0 - t;           // 1 → 0
      lifeScale = fade;
      lifeVisibility = fade;

      // 慢慢往下沉
      a.pos.y -= dt * 0.15 * fade;

      if (t >= 1.0) {
        a.state = LIFE.DEAD;
        a.obj.visible = false;
        if (a.trailLine) a.trailLine.visible = false;
        continue;
      }
    } else if (a.state === LIFE.NEWBORN) {
      a.newbornT += dt;
      const t = clamp(a.newbornT / NEWBORN_ANIM_DURATION, 0, 1);
      const eased = t * t * (3 - 2 * t); // smoothstep
      lifeScale = eased;
      lifeVisibility = eased;

      if (t >= 1.0) {
        a.state = LIFE.ALIVE;
        a.deathT = 0;
        lifeScale = 1.0;
        lifeVisibility = 1.0;
      }
    }

    a.lifeScale = lifeScale;
    a.lifeVisibility = lifeVisibility;

    // 2) Boids 세력
    let nCnt = 0;
    const align = new THREE.Vector3();
    const cohere = new THREE.Vector3();
    const separate = new THREE.Vector3();

    for (let j = 0; j < agents.length; j++) {
      if (j === i) continue;
      const b = agents[j];
      if (b.state === LIFE.DEAD) continue;

      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > PARAM.NEIGHBOR_R * PARAM.NEIGHBOR_R) continue;
      nCnt++;

      align.x += b.vel.x;
      align.z += b.vel.z;
      cohere.x += b.pos.x;
      cohere.z += b.pos.z;

      if (d2 < PARAM.SEP_R * PARAM.SEP_R) {
        const d = Math.max(1e-4, Math.sqrt(d2));
        separate.x -= dx / d;
        separate.z -= dz / d;
      }
    }

    if (nCnt > 0) {
      align.multiplyScalar(1 / nCnt);
      cohere.multiplyScalar(1 / nCnt);
      cohere.sub(a.pos);
    }

    // 3) 熱場
    const { rho, gradX, gradZ, rhoSun, gradSunX, gradSunZ } = sampleField(
      a.pos.x,
      a.pos.z,
      tSec
    );

    const dxs = Field.sun.pos.x - a.pos.x;
    const dzs = Field.sun.pos.y - a.pos.z;
    const distSun = Math.hypot(dxs, dzs);
    const farBoost = THREE.MathUtils.smoothstep(
      distSun,
      PARAM.FAR_ACCEL_INNER,
      PARAM.FAR_ACCEL_OUTER
    );

    let steerX = gradSunX * (PARAM.SUN_PULL * (0.6 + 0.7 * farBoost));
    let steerZ = gradSunZ * (PARAM.SUN_PULL * (0.6 + 0.7 * farBoost));
    {
      const d = distSun || 1.0;
      steerX += (dxs / d) * PARAM.SEEK_GAIN;
      steerZ += (dzs / d) * PARAM.SEEK_GAIN;
    }

    const isOverheated =
      Field.sun.heatPulse > PARAM.OVERHEAT_PULSE && rhoSun > PARAM.OVERHEAT_TEMP;
    if (isOverheated) {
      steerX -= gradSunX * PARAM.REPEL_GAIN;
      steerZ -= gradSunZ * PARAM.REPEL_GAIN;
    }

    // 驚嚇：點擊後, 圈內者往外逃
    if (tSec < Panic.activeUntil && distSun < visualR * Panic.radiusMul) {
      const d = Math.max(1e-4, distSun);
      const push = 14.0;
      steerX += -(dxs / d) * push;
      steerZ += -(dzs / d) * push;
    }

    // 4) 合成加速度 + wander
    let ax = 0,
      az = 0;
    ax += PARAM.ALIGN_W * align.x;
    az += PARAM.ALIGN_W * align.z;
    ax += PARAM.COHERE_W * cohere.x;
    az += PARAM.COHERE_W * cohere.z;
    ax += PARAM.SEPARATE_W * separate.x;
    az += PARAM.SEPARATE_W * separate.z;

    ax += steerX;
    az += steerZ;

    // nutrientForce
    const nutrientForce = getNutrientForce(a.pos);
    ax += nutrientForce.x * 0.7;
    az += nutrientForce.z * 0.7;

    a._noise += dt * 0.8;
    const J = 0.3;
    ax += J * Math.sin(a._noise * 1.7);
    az += J * Math.cos(a._noise * 1.3);

    const thrust = Math.hypot(ax, az);
    if (thrust < 0.18) {
      const d = distSun || 1.0;
      ax += 0.45 * (dxs / d);
      az += 0.45 * (dzs / d);
    }

    const speedFactor = clamp(a.speedFactor ?? 1.0, 0.5, 1.8);
    const steerLen = Math.hypot(ax, az);
    const steerMax = PARAM.STEER_MAX * speedFactor;
    if (steerLen > steerMax) {
      const s = steerMax / steerLen;
      ax *= s;
      az *= s;
    }

    const damp = Math.exp(-PARAM.DAMPING * dt);
    a.vel.x = (a.vel.x + ax * dt) * damp;
    a.vel.z = (a.vel.z + az * dt) * damp;

    const maxSp = PARAM.MAX_SPEED * speedFactor * (1.0 + 0.25 * nutrientBoost);
    const sp = Math.hypot(a.vel.x, a.vel.z);
    if (sp > maxSp) {
      const s = maxSp / sp;
      a.vel.x *= s;
      a.vel.z *= s;
    }

    // 位置更新
    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;

    // 經過時如果碰到營養源 → 吸收
    tryAbsorbNutrients(a);

    // 지나간 자리에 trail 남기기 (Deposit)
    const trailDepositBoost = 1.0 + 1.4 * nutrientBoost;
    depositTrail(
      a.pos.x,
      a.pos.z,
      TRAIL_DEPOSIT_AMOUNT * lifeVisibility * trailDepositBoost
    );

    // 5) 地形 貼地 + 坡度對齊
    let groundP, groundN;
    if (sampler) {
      const hit = sampler(a.pos.x, a.pos.z);
      groundP = hit.point;
      groundN = hit.normal;
    } else {
      groundP = new THREE.Vector3(a.pos.x, 0, a.pos.z);
      groundN = new THREE.Vector3(0, 1, 0);
    }

    if (!isFinite(a.pos.y) || Math.abs(a.pos.y - groundP.y) > PARAM.MAX_HOVER) {
      a.pos.y = groundP.y + PARAM.FOOT_OFFSET;
    }

    const slopeLift = (1.0 - THREE.MathUtils.clamp(groundN.y, 0, 1)) * 0.15;
    const baseY = groundP.y + PARAM.FOOT_OFFSET + slopeLift;

    a.yaw = yawTowards(a.yaw, a.vel.x, a.vel.z, dt);
    const upMixed = new THREE.Vector3(0, 1, 0).lerp(groundN, PARAM.SLOPE_ALIGN).normalize();
    const look = new THREE.Object3D();
    look.position.set(a.pos.x, baseY, a.pos.z);
    look.up.copy(upMixed);
    _tmp.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    look.lookAt(a.pos.x + _tmp.x, baseY + _tmp.y, a.pos.z + _tmp.z);

    // 6) 跳動
    const hopBoost = 1.0 + 0.4 * clamp(a.showOff ?? 0.5, 0, 1);
    a.hopPhase +=
      (PARAM.HOP_FREQ_BASE + PARAM.HOP_FREQ_FARBOOST * clamp(farBoost, 0, 1)) *
      dt *
      Math.PI *
      2;
    const sHop = 0.5 + 0.5 * Math.sin(a.hopPhase);
    const yHop = 4.0 * sHop * (1.0 - sHop) * PARAM.HOP_AMP * hopBoost;

    a.obj.position.set(a.pos.x, baseY + yHop, a.pos.z);
    a.obj.quaternion.copy(look.quaternion);

    // 6.5) trail 강도 → 크기 / 밝기 반영
    const trailStrength = getTrailStrengthAt(a.pos); // 0~1

    // 身體大小：trail + lifeScale + 營養加成
    const sizeMulTrail = 0.8 + 0.5 * trailStrength;
    const sizeMulNutrient = 1.0 + 0.4 * nutrientBoost;
    const finalScale = a.baseScale * sizeMulTrail * sizeMulNutrient * lifeScale;
    a.obj.scale.setScalar(finalScale);

    // 7) 熱暈 (紅色發光) + lifeVisibility + trailGlow + 營養 Glow
    let g = (rhoSun - PARAM.GLOW_INNER) / (PARAM.GLOW_OUTER - PARAM.GLOW_INNER);
    g = clamp(g, 0, 1);
    g = g * g * g;

    const trailGlowBoost = 0.7 * trailStrength;
    const nutrientGlowBoost = 0.6 * nutrientBoost;
    g = clamp(g + trailGlowBoost + nutrientGlowBoost, 0, 1);

    // 死亡/誕生過程中，同步淡入淡出
    g *= lifeVisibility;

    a.setGlow(g);

    // 8) emission line (Trail Line) 更新
    if (a.trailLine && a.trailPoints) {
      const trailY = baseY + 0.1;
      a.trailPoints.push(new THREE.Vector3(a.pos.x, trailY, a.pos.z));

      if (a.trailPoints.length > TRAIL_MAX_POINTS) {
        a.trailPoints.shift();
      }

      a.trailLine.geometry.setFromPoints(a.trailPoints);

      const mat = a.trailLine.material;
      const tTrail = trailStrength; // 0~1
      let alpha = 0.2 + 0.8 * tTrail;
      alpha *= (0.5 + 0.5 * nutrientBoost); // 吃過營養的軌跡更亮一點
      alpha *= lifeVisibility;             // 死亡時一起變淡，新生時慢慢變亮
      mat.opacity = alpha;
      mat.needsUpdate = true;

      // 顏色已在 applyGenomeToBoid 依照身體顏色設定過，
      // 這裡就讓亮暗由 trail 強度 / lifeVisibility / nutrientBoost 決定即可。
    }
  }

  updateTrailTexture();
  Field.sun.heatPulse *= 0.98;
}

/* 外部控制 */
export function setHeatPosXZ(x, z) {
  Field.sun.pos.set(x, z);
}
export function heatPulse() {
  Field.sun.heatPulse += 0.9;
}
export function getAgents() {
  return agents;
}
export function killNearest(x, z) {
  if (!agents.length) return;
  let k = -1,
    best = 1e9;
  for (let i = 0; i < agents.length; i++) {
    const d = Math.hypot(agents[i].pos.x - x, agents[i].pos.z - z);
    if (d < best) {
      best = d;
      k = i;
    }
  }
  if (k >= 0) {
    if (agents[k].obj) scene.remove(agents[k].obj);
    if (agents[k].trailLine) scene.remove(agents[k].trailLine);
    agents.splice(k, 1);
  }
}
