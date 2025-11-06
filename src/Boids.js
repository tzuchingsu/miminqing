// src/Boids.js
import * as THREE from "three";

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
  SEEK_GAIN: 6.2,      // 直接朝滑鼠中心
  SUN_PULL: 6.0,       // 熱場梯度
  FAR_ACCEL_INNER: 4.0,
  FAR_ACCEL_OUTER: 14.0,
  REPEL_GAIN: 3.8,     // 過熱/驚嚇外推

  // 姿態/貼地/跳動
  YAW_LERP: 8.0,
  FOOT_OFFSET: 0.06,
  SLOPE_ALIGN: 0.92,
  HOP_AMP: 0.22,
  HOP_FREQ_BASE: 2.0,
  HOP_FREQ_FARBOOST: 1.8,

  // 紅光門檻（往外推：更靠近中心才會亮）
  GLOW_INNER: 1.2,
  GLOW_OUTER: 5.8,

  // 過熱判定
  OVERHEAT_TEMP: 0.90,
  OVERHEAT_PULSE: 0.6,

  // 安全貼地（離地過高時強制貼回）
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
let raycaster, mouse;

const Field = {
  // 熱圈更大（spread↑）且稍微更強（baseI↑）
  sun: { pos: new THREE.Vector2(0,0), baseI: 4.8, spread: 12.0, heatPulse: 0.0 },
  D: 0.8, eps: 1e-3, emitters: [],
};

// 點擊後「驚嚇」窗口：圈內者會往外逃
const Panic = { activeUntil: 0, radiusMul: 1.15 };

/* ========================
 * 熱場取樣
 * ======================== */
function addEmitter(x, z, { intensity=6.0, spread=1.2, decayRate=1.0 } = {}) {
  Field.emitters.push({
    pos: new THREE.Vector2(x, z),
    I0: intensity, spread0: spread,
    birth: performance.now()*0.001, decay: decayRate
  });
}

function sampleField(x, z, tSec) {
  let rho=0, gx=0, gz=0, rhoSun=0, gxSun=0, gzSun=0;
  { // 主熱源（滑鼠）
    const I = Field.sun.baseI + Field.sun.heatPulse;
    const sigma2 = Field.sun.spread * Field.sun.spread;
    const dx = x - Field.sun.pos.x, dz = z - Field.sun.pos.y;
    const r2 = dx*dx + dz*dz;
    const G = I * Math.exp(-r2 / (2*sigma2));
    rho += G; rhoSun += G;
    const inv = 1 / sigma2;
    const gxP = G * (-dx * inv), gzP = G * (-dz * inv);
    gx += gxP; gz += gzP; gxSun += gxP; gzSun += gzP;
  }
  const now = tSec; const survivors = [];
  for (const e of Field.emitters) {
    const age = Math.max(0, now - e.birth);
    const I = e.I0 * Math.exp(-e.decay * age);
    if (I < Field.eps) continue; survivors.push(e);
    const sigma2 = e.spread0*e.spread0 + 2*Field.D*age;
    const dx = x - e.pos.x, dz = z - e.pos.y, r2 = dx*dx + dz*dz;
    const G = I * Math.exp(-r2 / (2*sigma2));
    rho += G; const inv = 1/sigma2;
    gx += G * (-dx * inv); gz += G * (-dz * inv);
  }
  Field.emitters = survivors;
  return { rho, gradX: gx, gradZ: gz, rhoSun, gradSunX: gxSun, gradSunZ: gzSun };
}

/* ========================
 * 熱圈可視化（拿掉刺眼的核心光斑，只留環）
 * ======================== */
function makeHeatVisual() {
  const group = new THREE.Group(); group.renderOrder = 9999;

  const ring = (inner, outer, col, op) => {
    const geo = new THREE.RingGeometry(inner, outer, 128);
    const mat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: op,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false
    });
    const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI*0.5;
    return m;
  };
  const ringOuter = ring(0.965, 1.0, new THREE.Color(1.0,0.85,0.35), 0.34);
  const ringInner = ring(0.82, 0.90, new THREE.Color(1.0,0.97,0.90), 0.28);
  group.add(ringOuter, ringInner);

  group.userData.update = ()=>{
    const pulse = THREE.MathUtils.clamp(Field.sun.heatPulse, 0, 3);
    // 視覺半徑（比前版更大）
    const baseR = 6.0 * (0.78 + 0.22 * pulse);
    ringOuter.scale.set(baseR, baseR, 1);
    ringInner.scale.set(baseR, baseR, 1);
    group.userData.visualRadius = baseR;
  };
  return group;
}

/* ========================
 * 工具
 * ======================== */
function clamp(v,min,max){return v<min?min:v>max?max:v;}
function angleDiff(a,b){const d=b-a;return Math.atan2(Math.sin(d),Math.cos(d));}
function yawTowards(currYaw,vx,vz,dt){
  const speed = Math.hypot(vx,vz);
  if (speed < 1e-3) return currYaw;
  const target = Math.atan2(vx, vz);
  const d = angleDiff(currYaw, target);
  const rate = 1.0 - Math.exp(-PARAM.YAW_LERP*dt);
  return currYaw + d*rate;
}

/* 每隻角色材質：關掉基礎發光，只用 uGlow 加紅光 */
function enablePerObjectGlow(node) {
  const mats = [];
  node.traverse((o)=>{
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(m=>m.clone()) : o.material.clone();
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    arr.forEach((m)=>{
      if ("emissive" in m) m.emissive.setRGB(0, 0, 0);           // 基礎發光顏色關掉
      if ("emissiveIntensity" in m) m.emissiveIntensity = 0.02;  // 初始幾乎不亮

      m.userData.uGlow = { value: 0.0 };
      m.onBeforeCompile = (shader)=>{
        shader.uniforms.uGlow = m.userData.uGlow;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `
#include <common>
uniform float uGlow;`)
          .replace('#include <emissivemap_fragment>', `
#include <emissivemap_fragment>
/* 離開熱圈：保持極低亮度 */
totalEmissiveRadiance *= 0.02;
/* 進入熱圈：用加法疊加紅光，不乘到爆亮 */
vec3 heatColor = vec3(1.0, 0.12, 0.0);
totalEmissiveRadiance += heatColor * (1.10 * uGlow);
/* uGlow=0 → 幾乎看不見；uGlow=1 → 明顯但不炸白 */
`);
      };
      m.needsUpdate = true;
      mats.push(m);
    });
  });
  return (g)=>{
    const v = clamp(g,0,1);
    mats.forEach(m=>{ if (m.userData?.uGlow) m.userData.uGlow.value = v; });
  };
}

/* ========================
 * 初始化
 * ======================== */
export function initBoids({
  scene: _scene, camera: _camera, renderer: _renderer,
  terrainRoot: _terrainRoot, prototypeNode, count = 20,
}) {
  scene = _scene; camera = _camera; renderer = _renderer;
  terrainRoot = _terrainRoot; protoNode = prototypeNode;
  PARAM.COUNT = count|0;

  sampler = terrainRoot?.userData?.heightSamplerWorld || null;
  if (!sampler) console.warn("[Boids] heightSamplerWorld 未提供，會退回 y=0 & up=(0,1,0)");

  // 熱圈可視化
  heatGroup = makeHeatVisual();
  scene.add(heatGroup);

  // 生成：Poisson 風格，開場就拉開距離；立刻貼地
  const size = terrainRoot?.userData?.size ?? 200;
  const spawnR = Math.min(16, size * 0.25);
  const used = [];
  for (let i = 0; i < PARAM.COUNT; i++) {
    let p, ok=false, tries=0;
    while (!ok && tries < 240) {
      const ang = Math.random()*Math.PI*2;
      const r = Math.sqrt(Math.random())*spawnR;
      p = new THREE.Vector3(Math.cos(ang)*r, 0, Math.sin(ang)*r);
      ok = used.every(q => p.distanceTo(q) > PARAM.SEP_R * 2.0); // 生成時距離再大一點
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
    inst.name = `ThermoBug_${i}`;
    inst.traverse(o=>{ if (o.isMesh) o.castShadow = o.receiveShadow = false; });
    const setGlow = enablePerObjectGlow(inst);
    scene.add(inst);

    const vel = new THREE.Vector3((Math.random()-0.5)*0.3, 0, (Math.random()-0.5)*0.3);
    const yaw = Math.random()*Math.PI*2;
    const hopPhase = Math.random()*Math.PI*2;

    agents.push({ obj: inst, pos: p, vel, yaw, hopPhase, setGlow, _noise: Math.random()*1000 });
  }

  // 滑鼠→地面
  raycaster = new THREE.Raycaster();

  const TERRAIN_TARGETS = [];
  if (terrainRoot?.userData?.collider?.isMesh) TERRAIN_TARGETS.push(terrainRoot.userData.collider);
  terrainRoot.traverse(o=>{ if (o?.isMesh && !TERRAIN_TARGETS.includes(o)) TERRAIN_TARGETS.push(o); });

  function pointerToXZ(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const mouseX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const mouseY = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera({x:mouseX, y:mouseY}, camera);
    const hit = raycaster.intersectObjects(TERRAIN_TARGETS, false)[0];
    if (hit) { Field.sun.pos.set(hit.point.x, hit.point.z); return; }
    // 沒打到地形時維持原位置
  }

  renderer.domElement.addEventListener("pointermove", pointerToXZ, { passive:true });
  renderer.domElement.addEventListener("click", (ev)=>{
    pointerToXZ(ev);
    addEmitter(Field.sun.pos.x, Field.sun.pos.y);
    Field.sun.heatPulse += 0.9;
    // 驚嚇窗口：圈內者強力外推
    Panic.activeUntil = performance.now()*0.001 + 0.9;
  }, { passive:true });
}

/* ========================
 * 每幀更新
 * ======================== */
const _tmp = new THREE.Vector3();
export function updateBoids(dt, tSec) {
  if (!agents.length) return;

  // 熱圈位置/半徑（跟地形貼齊）
  const groundAtSun = sampler ? sampler(Field.sun.pos.x, Field.sun.pos.y).point.y : 0;
  heatGroup.position.set(Field.sun.pos.x, groundAtSun + 0.01, Field.sun.pos.y);
  heatGroup.userData.update?.();
  const visualR = heatGroup.userData.visualRadius || 6.0;

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

    /* 1) Boids 三力（XZ） */
    let nCnt=0;
    const align = new THREE.Vector3();
    const cohere = new THREE.Vector3();
    const separate = new THREE.Vector3();
    for (let j = 0; j < agents.length; j++) if (j!==i) {
      const b = agents[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d2 = dx*dx + dz*dz;
      if (d2 > PARAM.NEIGHBOR_R*PARAM.NEIGHBOR_R) continue;
      nCnt++;
      align.x += b.vel.x; align.z += b.vel.z;
      cohere.x += b.pos.x; cohere.z += b.pos.z;
      if (d2 < PARAM.SEP_R*PARAM.SEP_R) {
        const d = Math.max(1e-4, Math.sqrt(d2));
        separate.x -= dx / d; separate.z -= dz / d;
      }
    }
    if (nCnt>0) {
      align.multiplyScalar(1/nCnt);
      cohere.multiplyScalar(1/nCnt);
      cohere.sub(a.pos);
    }

    /* 2) 熱場/追逐/過熱/驚嚇 */
    const { rho, gradX, gradZ, rhoSun, gradSunX, gradSunZ } =
      sampleField(a.pos.x, a.pos.z, tSec);

    const dxs = Field.sun.pos.x - a.pos.x;
    const dzs = Field.sun.pos.y - a.pos.z;
    const distSun = Math.hypot(dxs, dzs);
    const farBoost = THREE.MathUtils.smoothstep(distSun, PARAM.FAR_ACCEL_INNER, PARAM.FAR_ACCEL_OUTER);

    // 梯度吸引 + 直接追逐
    let steerX = gradSunX * (PARAM.SUN_PULL * (0.6 + 0.7*farBoost));
    let steerZ = gradSunZ * (PARAM.SUN_PULL * (0.6 + 0.7*farBoost));
    {
      const d = distSun || 1.0;
      steerX += (dxs / d) * PARAM.SEEK_GAIN;
      steerZ += (dzs / d) * PARAM.SEEK_GAIN;
    }

    // 過熱：反向離開
    const isOverheated = (Field.sun.heatPulse > PARAM.OVERHEAT_PULSE) && (rhoSun > PARAM.OVERHEAT_TEMP);
    if (isOverheated) {
      steerX -= gradSunX * PARAM.REPEL_GAIN;
      steerZ -= gradSunZ * PARAM.REPEL_GAIN;
    }

    // 驚嚇：點擊後，圈內者強力外推
    if (tSec < Panic.activeUntil && distSun < visualR * Panic.radiusMul) {
      const d = Math.max(1e-4, distSun);
      const push = 14.0;
      steerX += -(dxs / d) * push;
      steerZ += -(dzs / d) * push;
    }

    /* 3) 合成加速度 + wander + 保底推進 */
    let ax = 0, az = 0;
    ax += PARAM.ALIGN_W   * align.x;
    az += PARAM.ALIGN_W   * align.z;
    ax += PARAM.COHERE_W  * cohere.x;
    az += PARAM.COHERE_W  * cohere.z;
    ax += PARAM.SEPARATE_W* separate.x;
    az += PARAM.SEPARATE_W* separate.z;

    ax += steerX; az += steerZ;

    a._noise += dt * 0.8;
    const J = 0.30;
    ax += J * Math.sin(a._noise*1.7);
    az += J * Math.cos(a._noise*1.3);

    const thrust = Math.hypot(ax, az);
    if (thrust < 0.18) {
      const d = distSun || 1.0;
      ax += 0.45 * (dxs / d);
      az += 0.45 * (dzs / d);
    }

    const steerLen = Math.hypot(ax,az);
    if (steerLen > PARAM.STEER_MAX) { const s = PARAM.STEER_MAX / steerLen; ax*=s; az*=s; }

    // 積分 + 阻尼 + 最高速
    const damp = Math.exp(-PARAM.DAMPING * dt);
    a.vel.x = (a.vel.x + ax*dt) * damp;
    a.vel.z = (a.vel.z + az*dt) * damp;
    const sp = Math.hypot(a.vel.x, a.vel.z);
    if (sp > PARAM.MAX_SPEED) { const s = PARAM.MAX_SPEED / sp; a.vel.x*=s; a.vel.z*=s; }

    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;

    /* 4) 貼地與坡度對齊（含安全貼地） */
    let groundP, groundN;
    if (sampler) {
      const hit = sampler(a.pos.x, a.pos.z);
      groundP = hit.point; groundN = hit.normal;
    } else {
      groundP = new THREE.Vector3(a.pos.x, 0, a.pos.z);
      groundN = new THREE.Vector3(0,1,0);
    }

    // 安全貼地：離地太高或 NaN → 直接拉回
    if (!isFinite(a.pos.y) || Math.abs(a.pos.y - groundP.y) > PARAM.MAX_HOVER) {
      a.pos.y = groundP.y + PARAM.FOOT_OFFSET;
    }

    const slopeLift = (1.0 - THREE.MathUtils.clamp(groundN.y, 0, 1)) * 0.15;
    const baseY = groundP.y + PARAM.FOOT_OFFSET + slopeLift;

    a.yaw = yawTowards(a.yaw, a.vel.x, a.vel.z, dt);
    const upMixed = new THREE.Vector3(0,1,0).lerp(groundN, PARAM.SLOPE_ALIGN).normalize();
    const look = new THREE.Object3D();
    look.position.set(a.pos.x, baseY, a.pos.z);
    look.up.copy(upMixed);
    _tmp.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    look.lookAt(a.pos.x + _tmp.x, baseY + _tmp.y, a.pos.z + _tmp.z);

    // 跳動（使用前面算好的 farBoost，避免重複宣告）
    a.hopPhase += (PARAM.HOP_FREQ_BASE + PARAM.HOP_FREQ_FARBOOST * clamp(farBoost,0,1)) * dt * Math.PI*2;
    const sHop = 0.5 + 0.5 * Math.sin(a.hopPhase);
    const yHop = 4.0 * sHop * (1.0 - sHop) * PARAM.HOP_AMP;

    a.obj.position.set(a.pos.x, baseY + yHop, a.pos.z);
    a.obj.quaternion.copy(look.quaternion);

    /* 5) 熱暈（紅）：只有在熱圈才亮起 */
    let g = (rhoSun - PARAM.GLOW_INNER) / (PARAM.GLOW_OUTER - PARAM.GLOW_INNER);
    g = clamp(g, 0, 1); g = g*g*g;
    a.setGlow(g);
  }

  // 脈衝衰減
  Field.sun.heatPulse *= 0.98;
}

/* 外部控制（可選） */
export function setHeatPosXZ(x, z) { Field.sun.pos.set(x, z); }
export function heatPulse() { Field.sun.heatPulse += 0.9; }
export function getAgents(){ return agents; }

/* Debug：手動移除最靠近某點的一隻（若你想清掉異常個體） */
export function killNearest(x, z) {
  if (!agents.length) return;
  let k = -1, best = 1e9;
  for (let i = 0; i < agents.length; i++) {
    const d = Math.hypot(agents[i].pos.x - x, agents[i].pos.z - z);
    if (d < best) { best = d; k = i; }
  }
  if (k >= 0) {
    scene.remove(agents[k].obj);
    agents.splice(k, 1);
  }
}
