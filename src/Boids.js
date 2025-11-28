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
  "./assets/textures/RD5.png",  // patternId 4
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
  // h: 0~360
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

/* ========================
 * 발광 제어 (per object uGlow)
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

/**
 * Genome → Boid 매핑
 * - hue/value → 몸 색
 * - patternId → RD 텍스처
 * - bodyScale → 전체 스케일
 * - baseSpeed / showOff → 움직임에 영향 (per agent param)
 */
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

  // 2) 색상 (HSV → RGB, 채도는 showOff 기반)
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

  // 3) 스케일
  const scale = genome.bodyScale ?? 1.0;
  a.baseScale = scale;
  a.obj.scale.setScalar(scale);

  // 4) 움직임 파라미터 (per agent)
  a.speedFactor = genome.baseSpeed ?? 1.0;
  a.showOff = showOff;
}

/**
 * 새 세대 population 전체를 보이드에 적용
 * - indices 인자가 있으면 해당 슬롯만 적용
 */
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
 * 初始化
 * ======================== */

export function initBoids({
  scene: _scene,
  camera: _camera,
  renderer: _renderer,
  terrainRoot: _terrainRoot,
  prototypeNode,
  count = 20,
  initialGenomes = null, // GA에서 넘겨주는 초기 population
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

  // 生成 (Poisson-like)
  const size = terrainRoot?.userData?.size ?? 200;
  const spawnR = Math.min(16, size * 0.25);
  const used = [];
  agents = [];

  for (let i = 0; i < PARAM.COUNT; i++) {
    let p,
      ok = false,
      tries = 0;
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

    // 初始化時調整大小（你之前設 7.0，我幫你保留）
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

    const agent = {
      obj: inst,
      pos: p.clone(),
      vel,
      yaw,
      hopPhase,
      setGlow,
      _noise: Math.random() * 1000,
      // GA 관련
      genome: null,
      speedFactor: 1.0,
      showOff: 0.5,
      baseScale: 1.0,
      // Life state
      state: LIFE.ALIVE,
      deathT: 0,
      newbornT: 0,
    };

    agents.push(agent);
  }

  // 初始 Genome → 套用到 Boids
  if (initialGenomes && initialGenomes.length) {
    applyPopulationGenomes(initialGenomes);
  }

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
  for (const idx of survivorIndices) {
    const a = agents[idx];
    if (!a) continue;
    if (a.state === LIFE.DEAD) {
      a.state = LIFE.ALIVE;
      a.obj.visible = true;
      a.deathT = 0;
    }
  }

  for (const idx of doomedIndices) {
    const a = agents[idx];
    if (!a) continue;
    a.state = LIFE.DYING;
    a.deathT = 0;
    a.obj.visible = true;
  }
}

export function markNewborn(indices, duration = NEWBORN_ANIM_DURATION) {
  for (const idx of indices) {
    const a = agents[idx];
    if (!a) continue;
    a.state = LIFE.NEWBORN;
    a.newbornT = 0;
    a.obj.visible = true;
  }
}

/* ========================
 * 每幀更新
 * ======================== */

const _tmp = new THREE.Vector3();

export function updateBoids(dt, tSec) {
  if (!agents.length) return;

  // 熱圈位置 / 半徑
  const groundAtSun = sampler ? sampler(Field.sun.pos.x, Field.sun.pos.y).point.y : 0;
  heatGroup.position.set(Field.sun.pos.x, groundAtSun + 0.01, Field.sun.pos.y);
  heatGroup.userData.update?.();
  const visualR = heatGroup.userData.visualRadius || 6.0;

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

    if (a.state === LIFE.DEAD) {
      a.obj.visible = false;
      continue;
    }
    a.obj.visible = true;

    // 1) Life state 애니메이션
    if (a.state === LIFE.DYING) {
      a.deathT += dt;
      const t = clamp(a.deathT / DEATH_ANIM_DURATION, 0, 1);
      const s = THREE.MathUtils.lerp(1.0, 0.2, t);
      a.obj.scale.setScalar(a.baseScale * s);
      a.pos.y -= dt * 0.15;
      if (t >= 1.0) {
        a.state = LIFE.DEAD;
        a.obj.visible = false;
        continue;
      }
    } else if (a.state === LIFE.NEWBORN) {
      a.newbornT += dt;
      const t = clamp(a.newbornT / NEWBORN_ANIM_DURATION, 0, 1);
      const pulse = 1.0 + 0.15 * Math.sin(t * Math.PI * 2.0);
      const s = (0.2 + 0.8 * t) * pulse;
      a.obj.scale.setScalar(a.baseScale * s);
      if (t >= 1.0) {
        a.state = LIFE.ALIVE;
        a.obj.scale.setScalar(a.baseScale);
      }
    } else if (a.state === LIFE.ALIVE) {
      a.obj.scale.setScalar(a.baseScale);
    }

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

    const isOverheated = Field.sun.heatPulse > PARAM.OVERHEAT_PULSE && rhoSun > PARAM.OVERHEAT_TEMP;
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

    const maxSp = PARAM.MAX_SPEED * speedFactor;
    const sp = Math.hypot(a.vel.x, a.vel.z);
    if (sp > maxSp) {
      const s = maxSp / sp;
      a.vel.x *= s;
      a.vel.z *= s;
    }

    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;

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

    // 6) 跳動 (showOff 越大 → HOP_AMP 稍微增強)
    const hopBoost = 1.0 + 0.4 * clamp(a.showOff ?? 0.5, 0, 1);
    a.hopPhase +=
      (PARAM.HOP_FREQ_BASE + PARAM.HOP_FREQ_FARBOOST * clamp(farBoost, 0, 1)) *
      dt *
      Math.PI *
      2;
    const sHop = 0.5 + 0.5 * Math.sin(a.hopPhase);
    const yHop =
      4.0 * sHop * (1.0 - sHop) * PARAM.HOP_AMP * hopBoost;

    a.obj.position.set(a.pos.x, baseY + yHop, a.pos.z);
    a.obj.quaternion.copy(look.quaternion);

    // 7) 熱暈 (紅色發光)
    let g = (rhoSun - PARAM.GLOW_INNER) / (PARAM.GLOW_OUTER - PARAM.GLOW_INNER);
    g = clamp(g, 0, 1);
    g = g * g * g;
    a.setGlow(g);
  }

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
    scene.remove(agents[k].obj);
    agents.splice(k, 1);
  }
}
