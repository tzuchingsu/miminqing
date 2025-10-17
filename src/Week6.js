import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

/* =========================
 * 1) 렌더 파이프 구성 + HUD
 * ========================= */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(2, 2, 6);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
scene.add(new THREE.DirectionalLight(0xffffff, 1));

const controls = new OrbitControls(camera, renderer.domElement);

// FPS HUD
let hud = document.getElementById("fps");
if (!hud) {
  hud = document.createElement("div");
  hud.id = "fps";
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
 * 2) 배치 좌표 계산 (Layout)
 * ========================= */
const COUNT = 100;
const COLS  = 10;
const GAP_X = 1.5;
const GAP_Z = 1.5;

const positions = new Array(COUNT);
{
  const rows = Math.ceil(COUNT / COLS);
  const offX = (COLS - 1) * 0.5 * GAP_X;
  const offZ = (rows - 1) * 0.5 * GAP_Z;
  for (let i = 0; i < COUNT; i++) {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    positions[i] = new THREE.Vector3(c * GAP_X - offX, 0, r * GAP_Z - offZ);
  }
}

/* =========================
 * 3) 자산 로딩 준비 (텍스처)
 * ========================= */
function toPOTTexture(srcImage, size = 1024) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  ctx.drawImage(srcImage, 0, 0, size, size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;   // sRGB
  tex.premultiplyAlpha = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

let rdMat = null;
const texLoader = new THREE.TextureLoader();
texLoader.load("./assets/textures/RD.png", (tex) => {
  const rdPOT = toPOTTexture(tex.image, 1024);
  rdMat = new THREE.MeshStandardMaterial({
    map: rdPOT, metalness: 0, roughness: 1,
    side: THREE.DoubleSide, transparent: true, alphaTest: 0.5, depthWrite: true,
  });
  rdMat.map.repeat.set(1, 1);
  rdMat.map.needsUpdate = true;

  [instBody, instLegBall, instLegStick].forEach(inst => inst && syncInstancingRD(inst));
});

/* ==========================================
 * 4) LOD 컨테이너 / 상태 관리
 * ========================================== */
const LOD_NEAR_RADIUS = 3.0;
const lod = {
  mixers: new Map(), actions: new Map(),
  animSet: new Set(), idleSet: new Set(),
};

// 인스턴스 풀(파츠별)
let instBody = null, instLegBall = null, instLegStick = null;

/* ==========================================
 * 5) 인스턴스 파라미터 (무작위 동기화 깨기)
 * ========================================== */
const perInst = {
  phase0: new Float32Array(COUNT),
  freq:   new Float32Array(COUNT),  // jump Hz
  ampY:   new Float32Array(COUNT),  // jump height
  drift:  new Float32Array(COUNT),  // idle micro drift
  // ρ-기반 이동을 위한 상태
  posX:   new Float32Array(COUNT),  // 현재 x
  posZ:   new Float32Array(COUNT),  // 현재 z
  velX:   new Float32Array(COUNT),  // 속도 x
  velZ:   new Float32Array(COUNT),  // 속도 z
  yaw:    new Float32Array(COUNT),  // 바라보는 각
};
for (let i = 0; i < COUNT; i++) {
  perInst.phase0[i] = Math.random() * Math.PI * 2;
  perInst.freq[i]   = 0.55 + Math.random() * 0.25; // 0.55~0.8 Hz
  perInst.ampY[i]   = 0.28 + Math.random() * 0.18; // 0.28~0.46
  perInst.drift[i]  = 0.02 + Math.random() * 0.03; // 2~5 cm
  perInst.posX[i]   = positions[i].x;
  perInst.posZ[i]   = positions[i].z;
  perInst.velX[i]   = 0;
  perInst.velZ[i]   = 0;
  perInst.yaw[i]    = Math.random() * Math.PI * 2;
}

/* ===================================================
 * 6) 이름 기반 파츠 분해 + Instanced 풀 구성
 * =================================================== */
const PART_RULES = {
  Body:     [/Body/i, /Head/i, /Stem/i, /Torso/i, /Mycocurator/i],
  LegBall:  [/LegBall/i, /Foot.*Ball/i],
  LegStick: [/LegStick/i, /Foot.*Stick/i],
};

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
function matchAny(name, regexArr) { return regexArr?.some(r => r.test(name)) ?? false; }

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
  scene.add(inst);
  return inst;
}

/* GLB 로딩 */
const loader = new GLTFLoader();
loader.load("./assets/models/newmi.glb", (gltf) => {
  const root = gltf.scene;
  const merged = collectPartGeometries(root);

  instBody     = buildInstancedMesh(merged.Body, COUNT);
  instLegBall  = buildInstancedMesh(merged.LegBall, COUNT);
  instLegStick = buildInstancedMesh(merged.LegStick, COUNT);

  [instBody, instLegBall, instLegStick].forEach(inst => inst && syncInstancingRD(inst));
});

/* RD 텍스처 Instanced에 동기화 */
function syncInstancingRD(inst) {
  if (!inst) return;
  if (rdMat && rdMat.map) {
    inst.material.map = rdMat.map;
    inst.material.needsUpdate = true;
    const t = rdMat.map;
    console.log(`[syncInstancingRD] map synced (mip:${!!t.generateMipmaps}, repeat:${t.repeat.x}x${t.repeat.y})`);
  } else {
    console.warn("[syncInstancingRD] rdMat not found → material stays as-is");
  }
  console.log("[syncInstancingRD] if gray: check (1) material.map assigned, (2) minFilter/magFilter, (3) generateMipmaps, (4) wrapS/wrapT & repeat, (5) POT vs NPOT, (6) sRGB");
}

/* ==========================================================
 * ★ 밀도 필드 ρ(x,z,t) — 마우스=태양 + 가우시안 확산
 * ========================================================== */
const Field = {
  emitters: [],   // { pos:THREE.Vector2, I0, spread0, birth, decay }
  D: 0.8,         // 확산 계수 (σ^2(t) = σ0^2 + 2Dt)
  eps: 1e-3,
  // 태양(=마우스)
  sun: {
    pos: new THREE.Vector2(0, 0), // x,z 평면
    baseI: 3.0,     // 기본 강도 (끌림)
    spread: 5.0,    // 퍼짐
    heatPulse: 0.0, // 순간 가산
  },
};

function addEmitter(x, z, { intensity=2.5, spread=1.2, decayRate=0.6 } = {}) {
  Field.emitters.push({
    pos: new THREE.Vector2(x, z),
    I0: intensity,
    spread0: spread,
    birth: performance.now() * 0.001,
    decay: decayRate,
  });
}

/** ρ 샘플 + 기울기. sun 성분을 별도 반환하여 '반드시 끌림'에 사용 */
function sampleField(x, z, t) {
  let rho = 0, gx = 0, gz = 0;
  let rhoSun = 0, gxSun = 0, gzSun = 0;

  // 태양(마우스) 성분
  {
    const I = Field.sun.baseI + Field.sun.heatPulse;
    const sigma2 = Field.sun.spread * Field.sun.spread;
    const dx = x - Field.sun.pos.x, dz = z - Field.sun.pos.y;
    const r2 = dx*dx + dz*dz;
    const G = I * Math.exp(-r2 / (2 * sigma2));

    rho += G; rhoSun += G;
    const inv = 1 / sigma2;
    const gxPart = G * (-dx * inv);
    const gzPart = G * (-dz * inv);
    gx += gxPart; gz += gzPart;
    gxSun += gxPart; gzSun += gzPart;
  }

  // 일반 에미터들 (시간 감쇠 + 확산)
  const now = t;
  const survivors = [];
  for (const e of Field.emitters) {
    const age = Math.max(0, now - e.birth);
    const I = e.I0 * Math.exp(-e.decay * age);
    if (I < Field.eps) continue;
    survivors.push(e);

    const sigma2 = e.spread0*e.spread0 + 2 * Field.D * age;
    const dx = x - e.pos.x, dz = z - e.pos.y;
    const r2 = dx*dx + dz*dz;

    const G = I * Math.exp(-r2 / (2 * sigma2));
    rho += G;
    const inv = 1 / sigma2;
    gx += G * (-dx * inv);
    gz += G * (-dz * inv);
  }
  Field.emitters = survivors;

  return { rho, gradX: gx, gradZ: gz, rhoSun, gradSunX: gxSun, gradSunZ: gzSun, sunPos: Field.sun.pos };
}

/* 마우스 = 태양 위치 갱신 (y=0 평면) */
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
const hit = new THREE.Vector3();

function screenToGround(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (raycaster.ray.intersectPlane(groundPlane, hit)) {
    Field.sun.pos.set(hit.x, hit.z);
  }
}
window.addEventListener("mousemove", screenToGround);

// 클릭은 “균열/빛 폭발” 에미터로 유지(선택)
window.addEventListener("click", (ev) => {
  screenToGround(ev);
  addEmitter(Field.sun.pos.x, Field.sun.pos.y, { intensity: 5.0, spread: 0.8, decayRate: 1.0 });
  Field.sun.heatPulse += 0.8; // 잠깐 더 뜨거워짐
  setTimeout(()=> Field.sun.heatPulse *= 0.6, 250);
});

/* =========================
 * 7) 애니메이션 루프 연결
 * ========================= */
const _dummy = new THREE.Object3D();

/* three.js 구버전 호환: angleDiff */
function angleDiff(a, b) {
  const d = b - a;
  return Math.atan2(Math.sin(d), Math.cos(d)); // [-π, π]
}

/* 보조: smoothstep */
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function updateInstancedAnimation(insts, tSec) {
  const pools = insts.filter(Boolean);
  if (pools.length === 0) return;

  const n = COUNT;
  const twoPI = Math.PI * 2.0;

  // 간단 dt
  updateInstancedAnimation._lastT ??= tSec;
  let dt = Math.min(0.033, Math.max(0.0001, tSec - updateInstancedAnimation._lastT));
  updateInstancedAnimation._lastT = tSec;

  // LOD 재분류
  lod.animSet.clear(); lod.idleSet.clear();
  for (let i = 0; i < n; i++) {
    const d = camera.position.distanceTo(positions[i]);
    (d < LOD_NEAR_RADIUS ? lod.animSet : lod.idleSet).add(i);
  }
  const idxSet = lod.idleSet.size ? lod.idleSet : new Set([...Array(n).keys()]);

  // ρ 파라미터→행동 맵핑 임계값
  const RHO_GATHER_LOW  = 0.05;
  const RHO_GATHER_HIGH = 0.6;
  const RHO_REPULSE     = 1.2;    // 과열 반발 (※ 일반 에미터에만 적용)

  // 환경 저밀도 “굳음” 계수
  const freezeK = (rho)=> THREE.MathUtils.clamp(1.0 - rho*0.6, 0.15, 1.0);

  // 태양(마우스) 쪽 끌림 강도
  const SUN_PULL = 2.5;

  for (const i of idxSet) {
    // 필드 샘플
    const { rho, gradX, gradZ, rhoSun, gradSunX, gradSunZ, sunPos } =
      sampleField(perInst.posX[i], perInst.posZ[i], tSec);

    // 태양 방향으로 머리 돌리기: (sunPos - agentPos) 벡터 기준
    const dxSun = sunPos.x - perInst.posX[i];
    const dzSun = sunPos.y - perInst.posZ[i];
    const targetYaw = Math.atan2(dxSun, dzSun); // z-앞 기준
    const yawDelta = angleDiff(perInst.yaw[i], targetYaw);
    perInst.yaw[i] += yawDelta * 0.15; // 좀 더 빠르게 고개를 돌림

    // 이동성: 저밀도일수록 굳음
    const mobility = freezeK(rho);

    // 기본: 전체 필드 기울기 힘
    let fx = gradX;
    let fz = gradZ;

    // 태양(마우스) 끌림은 항상 '추가' (반발 대상 아님)
    fx += gradSunX * SUN_PULL;
    fz += gradSunZ * SUN_PULL;

    // 과열 반발은 일반 에미터 기여에만 적용하기 위해
    // “비-태양 성분의 rho”로 판정 (rho - rhoSun)
    const rhoOthers = Math.max(0, rho - rhoSun);
    if (rhoOthers > RHO_REPULSE) {
      // 비-태양 쪽은 피함
      fx -= gradSunX * SUN_PULL; // 태양 항은 유지한 채,
      fz -= gradSunZ * SUN_PULL; // 일반 항만 반전 효과를 주기 위해 보정
      fx = -fx; fz = -fz;
      // 다시 태양 끌림 더해줌 (결국 태양 쪽으로는 계속 당김)
      fx += gradSunX * SUN_PULL;
      fz += gradSunZ * SUN_PULL;
    }

    // gather 영역이면 조금 더 민첩
    const gatherBoost = (rho >= RHO_GATHER_LOW && rho <= RHO_GATHER_HIGH) ? 1.4 : 1.0;

    // 속도 적분 (점성 감쇠 포함)
    const K = 1.6 * gatherBoost;
    const DAMP = 2.2;
    perInst.velX[i] += (K * fx - DAMP * perInst.velX[i]) * dt * mobility;
    perInst.velZ[i] += (K * fz - DAMP * perInst.velZ[i]) * dt * mobility;

    // 홈 포지션 스프링(너무 퍼지지 않게)
    const px = perInst.posX[i], pz = perInst.posZ[i];
    const bx = positions[i].x,   bz = positions[i].z;
    const springK = 0.4;
    perInst.velX[i] += ( (bx - px) * springK ) * dt * mobility;
    perInst.velZ[i] += ( (bz - pz) * springK ) * dt * mobility;

    // 위치 적분
    perInst.posX[i] += perInst.velX[i] * dt;
    perInst.posZ[i] += perInst.velZ[i] * dt;

    // 점프(제자리) + 스쿼시: ρ에 따라 진폭/속도 조절(저밀도=작게)
    const phase = perInst.phase0[i] + perInst.freq[i] * mobility * tSec * twoPI;
    const s = 0.5 + 0.5 * Math.sin(phase);
    const yHop = 4.0 * s * (1.0 - s) * (perInst.ampY[i] * mobility);

    const contactBand = 0.18;
    const squashAmp = 0.22 * mobility;
    const contactWeight = 1 - smoothstep(0.0, contactBand, s);
    const squash = squashAmp * contactWeight;
    const sy  = 1.0 - squash;
    const sxz = 1.0 + squash * 0.8;

    _dummy.position.set(perInst.posX[i], yHop, perInst.posZ[i]);
    _dummy.rotation.set(0, perInst.yaw[i], 0);
    _dummy.scale.set(sxz, sy, sxz);
    _dummy.updateMatrix();

    for (const inst of pools) inst.setMatrixAt(i, _dummy.matrix);
  }
  for (const inst of pools) inst.instanceMatrix.needsUpdate = true;

  // 태양 순간 펄스 자연 감쇠
  Field.sun.heatPulse *= 0.98;
}

/* ========== 루프 & HUD 갱신 ========== */
let loopLogged = false;
function animate() {
  const t0 = performance.now();
  const t = t0 * 0.001; // seconds

  updateInstancedAnimation([instBody, instLegBall, instLegStick], t);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);

  if (!loopLogged) { console.log("[animate] loop started"); loopLogged = true; }

  // HUD 1초 갱신
  fpsFrames++;
  const tSec = t0 * 0.001;
  frameAccMs += performance.now() - t0;
  if (tSec - lastSec >= 1.0) {
    const fps = Math.round(fpsFrames / (tSec - lastSec));
    const avgMs = (frameAccMs / fpsFrames).toFixed(1);
    hud.textContent = `FPS: ${fps} | Avg: ${avgMs} ms`;
    fpsFrames = 0;
    frameAccMs = 0;
    lastSec = tSec;
  }

  controls.update();
}
animate();

/* ========== 리사이즈 ========== */
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
