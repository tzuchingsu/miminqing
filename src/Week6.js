import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/* =========================
 * 1) 渲染管線 + HUD
 * ========================= */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(2, 2, 6);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Bloom（更挑剔）
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  /* strength */ 0.9,   // 收斂
  /* radius   */ 0.18,  // 更利更窄
  /* threshold*/ 0.82   // 只吃非常亮的
);
composer.addPass(bloomPass);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
scene.add(new THREE.DirectionalLight(0xffffff, 1));

const controls = new OrbitControls(camera, renderer.domElement);

// FPS HUD
let hud = document.getElementById("fps");
if (!hud) {
  hud = document.createElement("div");
  Object.assign(hud.style, {
    position: "fixed", left: "10px", top: "10px",
    padding: "6px 10px",
    background: "rgba(0,0,0,0.55)",
    color: "#0f0",
    fontFamily: "monospace",
    fontSize: "12px",
    borderRadius: "6px",
    zIndex: 9999,
    pointerEvents: "none",
  });
  hud.textContent = "FPS: -- | Avg: -- ms";
  document.body.appendChild(hud);
}
let fpsFrames = 0, lastSec = performance.now() * 0.001;
let frameAccMs = 0;

/* =========================
 * 2) 佈局座標
 * ========================= */
const COUNT = 100, COLS = 10, GAP_X = 1.5, GAP_Z = 1.5;
const positions = new Array(COUNT);
{
  const rows = Math.ceil(COUNT / COLS);
  const offX = (COLS - 1) * 0.5 * GAP_X;
  const offZ = (rows - 1) * 0.5 * GAP_Z;
  for (let i = 0; i < COUNT; i++) {
    const r = Math.floor(i / COLS), c = i % COLS;
    positions[i] = new THREE.Vector3(c * GAP_X - offX, 0, r * GAP_Z - offZ);
  }
}

/* =========================
 * 3) 紋理載入與處理 (反相遮罩)
 * ========================= */
function toPOTTexture(srcImage, size = 1024) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  ctx.drawImage(srcImage, 0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.premultiplyAlpha = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}
function makeInvertedMaskTexture(srcImage, size = 1024) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  ctx.drawImage(srcImage, 0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const luma = 0.299*r + 0.587*g + 0.114*b;
    const inv  = 255 - luma;
    d[i] = d[i+1] = d[i+2] = inv;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

// Shader 補丁：用每實例 glow 讓 emissive「更紅更亮」，只影響裂紋（在 emissivemap 段後混色）
function patchGlowShader(material) {
  material.userData.uHotColor = new THREE.Color(0xFF3A00); // 熱紅色
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHotColor = { value: material.userData.uHotColor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
#include <common>
attribute float aGlow;
varying float vGlow;`)
      .replace('#include <begin_vertex>', `
#include <begin_vertex>
vGlow = aGlow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
#include <common>
varying float vGlow;
uniform vec3 uHotColor;`)
      .replace('#include <emissivemap_fragment>', `
#include <emissivemap_fragment>
// ---- per-instance glow begin ----
float glow = clamp(vGlow, 0.0, 1.0);
// 只在裂紋（emissivemap 已作用的 totalEmissiveRadiance 上）加熱偏紅與強度
totalEmissiveRadiance = mix(totalEmissiveRadiance, uHotColor, 0.7 * glow);
// 亮度曲線更克制：範圍小、近中心才亮
totalEmissiveRadiance *= (0.12 + 1.2 * glow);
// ---- per-instance glow end ----
`);
  };
  material.needsUpdate = true;
}

let rdMat = null;
const texLoader = new THREE.TextureLoader();
texLoader.load("./assets/textures/RD.png", (tex) => {
  const rdPOT   = toPOTTexture(tex.image, 1024);
  const maskInv = makeInvertedMaskTexture(tex.image, 1024);

  rdMat = new THREE.MeshStandardMaterial({
    map: rdPOT,
    metalness: 0, roughness: 1,
    side: THREE.DoubleSide,
    transparent: true, alphaTest: 0.5, depthWrite: true,
    emissive: new THREE.Color(0xFFD080), // 基礎暖光色仍保留
    emissiveMap: maskInv,                // 只有裂紋會發光
    emissiveIntensity: 7.0,              // 降低遠處底光
  });

  patchGlowShader(rdMat);
  rdMat.map.repeat.set(1, 1);
  rdMat.emissiveMap.repeat.set(1, 1);

  [instBody, instLegBall, instLegStick].forEach(inst => inst && syncInstancingRD(inst));
});

/* ==========================================
 * 4) LOD & Instanced pools
 * ========================================== */
const LOD_NEAR_RADIUS = 3.0;
const lod = { animSet: new Set(), idleSet: new Set() };
let instBody = null, instLegBall = null, instLegStick = null;

/* ==========================================
 * 5) 每實例參數
 * ========================================== */
const perInst = {
  phase0: new Float32Array(COUNT),
  freq:   new Float32Array(COUNT),
  ampY:   new Float32Array(COUNT),
  drift:  new Float32Array(COUNT),
  posX:   new Float32Array(COUNT),
  posZ:   new Float32Array(COUNT),
  velX:   new Float32Array(COUNT),
  velZ:   new Float32Array(COUNT),
  yaw:    new Float32Array(COUNT),
  glow:   new Float32Array(COUNT), // 0~1
};
for (let i = 0; i < COUNT; i++) {
  perInst.phase0[i] = Math.random() * Math.PI * 2;
  perInst.freq[i]   = 0.55 + Math.random() * 0.25;
  perInst.ampY[i]   = 0.28 + Math.random() * 0.18;
  perInst.drift[i]  = 0.02 + Math.random() * 0.03;
  perInst.posX[i]   = positions[i].x;
  perInst.posZ[i]   = positions[i].z;
  perInst.velX[i]   = 0;
  perInst.velZ[i]   = 0;
  perInst.yaw[i]    = Math.random() * Math.PI * 2;
  perInst.glow[i]   = 0;
}

/* ===================================================
 * 6) 零件分桶 + InstancedMesh
 * =================================================== */
const PART_RULES = {
  Body:     [/Body/i, /Head/i, /Stem/i, /Torso/i, /Mycocurator/i],
  LegBall:  [/LegBall/i, /Foot.*Ball/i],
  LegStick: [/LegStick/i, /Foot.*Stick/i],
};
function matchAny(name, regexArr) { return regexArr?.some(r => r.test(name)) ?? false; }

function collectPartGeometries(root) {
  const buckets = { Body: [], LegBall: [], LegStick: [] };
  root.updateWorldMatrix(true, true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    const geom = o.geometry;
    const pos  = geom?.getAttribute?.("position");
    if (!pos) return;
    let part = null;
    if (matchAny(o.name, PART_RULES.LegBall)) part = "LegBall";
    else if (matchAny(o.name, PART_RULES.LegStick)) part = "LegStick";
    else if (matchAny(o.name, PART_RULES.Body)) part = "Body";
    if (!part) return;
    let g = geom.index ? geom.toNonIndexed() : geom.clone();
    const xform = new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld);
    g.applyMatrix4(xform);
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    buckets[part].push(g);
  });
  const merged = {};
  for (const key of Object.keys(buckets)) {
    const arr = buckets[key];
    if (arr.length === 0) { merged[key] = null; continue; }
    const mg = BufferGeometryUtils.mergeGeometries(arr, false);
    merged[key] = mg?.index ? mg.toNonIndexed() : mg;
  }
  return merged;
}

function addGlowAttribute(inst, count = COUNT) {
  if (!inst) return;
  if (!inst.geometry.getAttribute("aGlow")) {
    inst.geometry.setAttribute("aGlow", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  }
}
function updateGlowAttribute(inst, src) {
  if (!inst) return;
  const attr = inst.geometry.getAttribute("aGlow");
  if (!attr) return;
  for (let i = 0; i < src.length; i++) attr.setX(i, src[i]);
  attr.needsUpdate = true;
}

function buildInstancedMesh(geom, count = COUNT) {
  if (!geom) return null;
  const mat = rdMat ?? new THREE.MeshStandardMaterial({ color: 0xffffff });
  if (!rdMat) console.warn("[buildInstancedMesh] rdMat not found → using fallback material");
  const inst = new THREE.InstancedMesh(geom, mat, count);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    dummy.position.set(perInst.posX[i], 0, perInst.posZ[i]);
    dummy.rotation.set(0, perInst.yaw[i], 0);
    dummy.scale.set(1,1,1);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  addGlowAttribute(inst, count);
  scene.add(inst);
  return inst;
}

/* GLB 載入 */
const loader = new GLTFLoader();
loader.load("./assets/models/newmi.glb", (gltf) => {
  const root = gltf.scene;
  const merged = collectPartGeometries(root);
  instBody     = buildInstancedMesh(merged.Body, COUNT);
  instLegBall  = buildInstancedMesh(merged.LegBall, COUNT);
  instLegStick = buildInstancedMesh(merged.LegStick, COUNT);
  [instBody, instLegBall, instLegStick].forEach(inst => inst && syncInstancingRD(inst));
});
function syncInstancingRD(inst) {
  if (!inst) return;
  if (rdMat && rdMat.map) { inst.material = rdMat; inst.material.needsUpdate = true; }
  else console.warn("[syncInstancingRD] rdMat not ready yet");
}

/* ==========================================================
 * 7) 密度場 ρ(x,z,t) — 滑鼠太陽 + 高斯擴散
 * ========================================================== */
const Field = {
  emitters: [],
  D: 0.8,
  eps: 1e-3,
  sun: { pos: new THREE.Vector2(0, 0), baseI: 3.0, spread: 5.0, heatPulse: 0.0 },
};
function addEmitter(x, z, { intensity=5.0, spread=0.8, decayRate=1.0 } = {}) {
  Field.emitters.push({ pos: new THREE.Vector2(x, z), I0: intensity, spread0: spread, birth: performance.now() * 0.001, decay: decayRate });
}
function sampleField(x, z, t) {
  let rho = 0, gx = 0, gz = 0, rhoSun = 0, gxSun = 0, gzSun = 0;
  { // 太陽
    const I = Field.sun.baseI + Field.sun.heatPulse;
    const sigma2 = Field.sun.spread * Field.sun.spread;
    const dx = x - Field.sun.pos.x, dz = z - Field.sun.pos.y;
    const r2 = dx*dx + dz*dz;
    const G = I * Math.exp(-r2 / (2 * sigma2));
    rho += G; rhoSun += G;
    const inv = 1 / sigma2;
    const gxPart = G * (-dx * inv), gzPart = G * (-dz * inv);
    gx += gxPart; gz += gzPart; gxSun += gxPart; gzSun += gzPart;
  }
  const now = t; const survivors = [];
  for (const e of Field.emitters) {
    const age = Math.max(0, now - e.birth);
    const I = e.I0 * Math.exp(-e.decay * age);
    if (I < Field.eps) continue; survivors.push(e);
    const sigma2 = e.spread0*e.spread0 + 2 * Field.D * age;
    const dx = x - e.pos.x, dz = z - e.pos.y; const r2 = dx*dx + dz*dz;
    const G = I * Math.exp(-r2 / (2 * sigma2));
    rho += G; const inv = 1 / sigma2; gx += G * (-dx * inv); gz += G * (-dz * inv);
  }
  Field.emitters = survivors;
  return { rho, gradX: gx, gradZ: gz, rhoSun, gradSunX: gxSun, gradSunZ: gzSun, sunPos: Field.sun.pos };
}

/* 滑鼠投影到地面 (y=0) */
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
const hit = new THREE.Vector3();
function screenToGround(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (raycaster.ray.intersectPlane(groundPlane, hit)) Field.sun.pos.set(hit.x, hit.z);
}
window.addEventListener("mousemove", screenToGround);
window.addEventListener("click", (ev) => {
  screenToGround(ev);
  addEmitter(Field.sun.pos.x, Field.sun.pos.y);
  Field.sun.heatPulse += 0.8;
  setTimeout(()=> Field.sun.heatPulse *= 0.6, 250);
});

/* =========================
 * 8) 物理參數 + 工具
 * ========================= */
const MAX_SPEED=1.8, STEER_GAIN=1.6, SPRING_K=0.4, DAMPING=1.8, YAW_LERP=6.0, MIN_SPEED_EPS=1e-3;
const RHO_GATHER_LOW=0.05, RHO_GATHER_HIGH=0.6;
const OVERHEAT_TEMP=0.8, OVERHEAT_PULSE=0.6, FAR_ACCEL_INNER=5.0, FAR_ACCEL_OUTER=12.0, REPEL_GAIN=3.5;
function angleDiff(a,b){const d=b-a;return Math.atan2(Math.sin(d),Math.cos(d));}
function smoothstep(e0,e1,x){const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);}
function yawTowardsVelocity(currYaw,vx,vz,dt){const speed=Math.hypot(vx,vz);if(speed<MIN_SPEED_EPS)return currYaw;const target=Math.atan2(vx,vz);const d=angleDiff(currYaw,target);const rate=1.0-Math.exp(-YAW_LERP*dt);return currYaw+d*rate;}

/* =========================
 * 9) 熱圈可視化（更小更不刺眼）
 * ========================= */
function makeRadialGlowTexture(size = 512) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0.0, 'rgba(255,220,120,1.0)');
  g.addColorStop(0.35,'rgba(255,180,60,0.55)');
  g.addColorStop(0.65,'rgba(255,140,40,0.25)');
  g.addColorStop(1.0, 'rgba(255,120,0,0.0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,size,size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
  return tex;
}
const HEAT_VIS = {
  intensity: 2.2,      // ↓ 原來 3.2
  baseRadius: 2.2,     // ↓ 原來 3.5
  ringThickness: 0.2,
  ringColor: new THREE.Color(1.0, 0.85, 0.35),
  ringColor2: new THREE.Color(1.0, 0.95, 0.8),
};
const heatGroup = new THREE.Group(); heatGroup.renderOrder = 9999; scene.add(heatGroup);
const glowTex = makeRadialGlowTexture(512);
const glowMat = new THREE.MeshBasicMaterial({
  map: glowTex, transparent: true, opacity: 0.8,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
});
const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1,1), glowMat);
glowPlane.rotation.x = -Math.PI * 0.5; heatGroup.add(glowPlane);
function makeRingMesh(inner, outer, color){
  const geo = new THREE.RingGeometry(inner, outer, 128);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.rotation.x = -Math.PI * 0.5; return mesh;
}
const ringOuter = makeRingMesh(0.9, 1.0, HEAT_VIS.ringColor);
const ringInner = makeRingMesh(0.75, 0.85, HEAT_VIS.ringColor2);
heatGroup.add(ringOuter); heatGroup.add(ringInner);
const heatScalePivot = new THREE.Group(); heatGroup.add(heatScalePivot);
heatScalePivot.add(glowPlane); heatScalePivot.add(ringOuter); heatScalePivot.add(ringInner);

function updateHeatVisual() {
  heatGroup.position.set(Field.sun.pos.x, 0.001, Field.sun.pos.y);
  const pulse = THREE.MathUtils.clamp(Field.sun.heatPulse, 0, 3);
  const radius = HEAT_VIS.baseRadius * (0.7 + 0.15 * pulse); // 脈衝對半徑影響更小
  glowPlane.scale.set(radius*2.0, radius*2.0, 1);
  heatScalePivot.scale.set(radius, 1, radius);

  const bright = HEAT_VIS.intensity * (0.8 + 0.5 * pulse);  // 整體亮度收斂
  glowMat.opacity = 0.2 * bright;                          // ↓ 原 0.28
  ringOuter.material.opacity = 0.35 * Math.min(1.0, 0.35 * bright);
  ringInner.material.opacity = 0.28 * Math.min(1.0, 0.45 * bright);

  const t = THREE.MathUtils.clamp(HEAT_VIS.ringThickness, 0.05, 0.45);
  ringOuter.geometry.dispose(); ringOuter.geometry = new THREE.RingGeometry(1.0 - t*0.35, 1.0, 128);
  ringInner.geometry.dispose(); ringInner.geometry = new THREE.RingGeometry(0.8 - t*0.3, 0.8, 128);
}

/* =========================
 * 10) 動畫更新：運動 + 熱圈 + 發光係數(小範圍)
 * ========================= */
const _dummy = new THREE.Object3D();
function updateInstancedAnimation(insts, tSec) {
  const pools = insts.filter(Boolean);
  if (pools.length === 0) { updateHeatVisual(); return; }

  updateInstancedAnimation._lastT ??= tSec;
  let dt = Math.min(0.033, Math.max(0.0001, tSec - updateInstancedAnimation._lastT));
  updateInstancedAnimation._lastT = tSec;

  lod.animSet.clear(); lod.idleSet.clear();
  for (let i = 0; i < COUNT; i++) {
    const d = camera.position.distanceTo(positions[i]);
    (d < LOD_NEAR_RADIUS ? lod.animSet : lod.idleSet).add(i);
  }

  // 發光映射：只在中心附近才會紅
  const GLOW_INNER = 0.7; // 低於此值幾乎不紅
  const GLOW_OUTER = 3.0; // 到這就滿紅（區間很窄）

  for (let i = 0; i < COUNT; i++) {
    const { rho, gradX, gradZ, rhoSun, gradSunX, gradSunZ, sunPos } =
      sampleField(perInst.posX[i], perInst.posZ[i], tSec);

    // glow：以 rhoSun → 縮小範圍 + 立方銳化
    let g = (rhoSun - GLOW_INNER) / (GLOW_OUTER - GLOW_INNER);
    g = THREE.MathUtils.clamp(g, 0, 1);
    let glow = g * g * g;  // 立方讓邊緣迅速掉光
    perInst.glow[i] = glow;

    // === 既有運動邏輯 ===
    const mobility = THREE.MathUtils.clamp(1.0 - rho * 0.6, 0.15, 1.0);
    const SUN_PULL = 3.2;
    let steerX = gradX + gradSunX * SUN_PULL;
    let steerZ = gradZ + gradSunZ * SUN_PULL;

    const rhoOthers = Math.max(0, rho - rhoSun);
    if (rhoOthers > 1.2) {
      steerX = -steerX + gradSunX * SUN_PULL;
      steerZ = -steerZ + gradSunZ * SUN_PULL;
    }

    const isOverheated = (Field.sun.heatPulse > OVERHEAT_PULSE) && (rhoSun > OVERHEAT_TEMP);
    if (isOverheated) {
      steerX -= gradSunX * REPEL_GAIN;
      steerZ -= gradSunZ * REPEL_GAIN;
    } else {
      const dxs = perInst.posX[i] - sunPos.x, dzs = perInst.posZ[i] - sunPos.y;
      const distSun = Math.hypot(dxs, dzs);
      const farBoost = smoothstep(FAR_ACCEL_INNER, FAR_ACCEL_OUTER, distSun);
      steerX += gradSunX * (SUN_PULL * 0.6 * farBoost);
      steerZ += gradSunZ * (SUN_PULL * 0.6 * farBoost);
    }

    const gatherBoost = (rho >= RHO_GATHER_LOW && rho <= RHO_GATHER_HIGH) ? 1.4 : 1.0;
    let ax = (STEER_GAIN * gatherBoost) * steerX;
    let az = (STEER_GAIN * gatherBoost) * steerZ;
    const px = perInst.posX[i], pz = perInst.posZ[i];
    const bx = positions[i].x,   bz = positions[i].z;
    ax += SPRING_K * (bx - px); az += SPRING_K * (bz - pz);
    ax *= mobility; az *= mobility;

    perInst.velX[i] += ax * dt; perInst.velZ[i] += az * dt;
    const damp = Math.exp(-DAMPING * dt);
    perInst.velX[i] *= damp; perInst.velZ[i] *= damp;

    const speed = Math.hypot(perInst.velX[i], perInst.velZ[i]);
    if (speed > MAX_SPEED) { const s = MAX_SPEED / speed; perInst.velX[i] *= s; perInst.velZ[i] *= s; }

    perInst.posX[i] += perInst.velX[i] * dt;
    perInst.posZ[i] += perInst.velZ[i] * dt;

    perInst.yaw[i] = yawTowardsVelocity(perInst.yaw[i], perInst.velX[i], perInst.velZ[i], dt);

    const twoPI = Math.PI * 2.0;
    const ph = perInst.phase0[i] + perInst.freq[i] * mobility * tSec * twoPI;
    const s = 0.5 + 0.5 * Math.sin(ph);
    const yHop = 4.0 * s * (1.0 - s) * (perInst.ampY[i] * mobility);

    const contactBand = 0.18, squashAmp = 0.22 * mobility;
    const contactWeight = 1 - smoothstep(0.0, contactBand, s);
    const squash = squashAmp * contactWeight;
    const sy  = 1.0 - squash, sxz = 1.0 + squash * 0.8;

    _dummy.position.set(perInst.posX[i], yHop, perInst.posZ[i]);
    _dummy.rotation.set(0, perInst.yaw[i], 0);
    _dummy.scale.set(sxz, sy, sxz);
    _dummy.updateMatrix();
    for (const inst of pools) inst.setMatrixAt(i, _dummy.matrix);
  }

  // 同步 aGlow
  for (const inst of pools) updateGlowAttribute(inst, perInst.glow);
  for (const inst of pools) inst.instanceMatrix.needsUpdate = true;

  Field.sun.heatPulse *= 0.98;
  updateHeatVisual();
}

/* ========== 迴圈 & HUD ========== */
let loopLogged = false;
function animate() {
  const t0 = performance.now();
  const t = t0 * 0.001;
  updateInstancedAnimation([instBody, instLegBall, instLegStick], t);
  composer.render(); // 使用 Bloom 管線
  requestAnimationFrame(animate);

  if (!loopLogged) { console.log("[animate] loop started"); loopLogged = true; }
  fpsFrames++; const tSec = t0 * 0.001; frameAccMs += performance.now() - t0;
  if (tSec - lastSec >= 1.0) {
    const fps = Math.round(fpsFrames / (tSec - lastSec));
    const avgMs = (frameAccMs / fpsFrames).toFixed(1);
    hud.textContent = `FPS: ${fps} | Avg: ${avgMs} ms`;
    fpsFrames = 0; frameAccMs = 0; lastSec = tSec;
  }
  controls.update();
}
animate();

/* ========== 視窗縮放 ========== */
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
