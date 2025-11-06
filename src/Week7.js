// Week7.js — B+M: 中高山(26x26) + 生物「貼坡行走」+ 分離力 + 熱圈貼地
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
camera.position.set(8, 6, 10);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.18, 0.82);
composer.addPass(bloomPass);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.9));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(5, 8, 4);
scene.add(dir);

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
 * 2) 佈局座標（100 隻，10x10）
 * ========================= */
const COUNT = 100, COLS = 10, GAP_X = 1.4, GAP_Z = 1.4;
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

// Emissive glow 補丁（保留你的裂紋發光邏輯）
function patchGlowShader(material) {
  material.userData.uHotColor = new THREE.Color(0xFF3A00);
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
float glow = clamp(vGlow, 0.0, 1.0);
totalEmissiveRadiance = mix(totalEmissiveRadiance, uHotColor, 0.7 * glow);
totalEmissiveRadiance *= (0.12 + 1.2 * glow);
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
    emissive: new THREE.Color(0xFFD080),
    emissiveMap: maskInv,
    emissiveIntensity: 6.5,
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
  glow:   new Float32Array(COUNT),
  baseY:  new Float32Array(COUNT),
};
for (let i = 0; i < COUNT; i++) {
  perInst.phase0[i] = Math.random() * Math.PI * 2;
  perInst.freq[i]   = 0.55 + Math.random() * 0.25;
  perInst.ampY[i]   = 0.08 + Math.random() * 0.05; // 小跳動，避免浮感
  perInst.drift[i]  = 0.02 + Math.random() * 0.03;
  perInst.posX[i]   = positions[i].x;
  perInst.posZ[i]   = positions[i].z;
  perInst.velX[i]   = 0;
  perInst.velZ[i]   = 0;
  perInst.yaw[i]    = Math.random() * Math.PI * 2;
  perInst.glow[i]   = 0;
  perInst.baseY[i]  = 0;
}

/* ===================================================
 * 6) 零件分桶 + InstancedMesh（→ 重要：統一把 minY rebasing 到 0）
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
    g.computeBoundingBox();
    buckets[part].push(g);
  });

  // 先合併
  const merged = {};
  for (const key of Object.keys(buckets)) {
    const arr = buckets[key];
    if (arr.length === 0) { merged[key] = null; continue; }
    const mg = BufferGeometryUtils.mergeGeometries(arr, false);
    merged[key] = mg?.index ? mg.toNonIndexed() : mg;
    merged[key].computeBoundingBox();
  }

  // ★★★ Rebase：找到所有零件的 global minY，統一下移，使「腳底 = y=0」
  let globalMinY = +Infinity;
  for (const k of Object.keys(merged)) {
    const g = merged[k];
    if (!g || !g.boundingBox) continue;
    globalMinY = Math.min(globalMinY, g.boundingBox.min.y);
  }
  if (Number.isFinite(globalMinY) && Math.abs(globalMinY) > 1e-6) {
    const T = new THREE.Matrix4().makeTranslation(0, -globalMinY, 0);
    for (const k of Object.keys(merged)) {
      const g = merged[k];
      if (!g) continue;
      g.applyMatrix4(T);
      g.computeBoundingBox();
    }
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
}

/* ==========================================================
 * 7) 地形（B+M：26×26、有高山）
 * ========================================================== */
const TERRAIN = {
  mesh: null,
  sizeX: 16, sizeZ: 16,
  maxHeight: 4.2,
  res: 192,
  offsetY: -0.3
};

// 柔和丘陵 + 幾個高斯山峰
function generateHeight(res, sizeX, sizeZ){
  const data = new Float32Array(res*res);
  const kx1 = 2.0*Math.PI/sizeX * 0.6;
  const kz1 = 2.0*Math.PI/sizeZ * 0.6;
  const kx2 = 2.0*Math.PI/sizeX * 1.0;
  const kz2 = 2.0*Math.PI/sizeZ * 0.9;

  function addHill(cx, cz, r, amp){
    for(let j=0;j<res;j++){
      for(let i=0;i<res;i++){
        const u = i/(res-1), v = j/(res-1);
        const x = (u-0.5)*sizeX, z = (v-0.5)*sizeZ;
        const dx = x - cx, dz = z - cz;
        const r2 = dx*dx + dz*dz;
        data[j*res+i] += amp * Math.exp(-r2/(2*r*r));
      }
    }
  }

  // 基底起伏
  for (let j=0;j<res;j++){
    for (let i=0;i<res;i++){
      const u=i/(res-1), v=j/(res-1);
      const x=(u-0.5)*sizeX, z=(v-0.5)*sizeZ;
      let h  = 0.50*Math.sin(kx1*x+0.6)*Math.cos(kz1*z+1.4);
      h     += 0.30*Math.sin(kx2*x+1.8)*Math.sin(kz2*z+0.9);
      data[j*res+i] = h*0.6;
    }
  }
  // 兩座山 + 一個小丘
  addHill( 2.5,  1.8, 2.6,  0.9);
  addHill(-3.0, -1.5, 2.0,  0.7);
  addHill( 0.0,  0.0, 1.2,  0.35);

  // 正規化到 [0,1]
  let min=Infinity,max=-Infinity;
  for (let v of data){ if(v<min)min=v; if(v>max)max=v; }
  const range = (max-min) || 1;
  for (let i=0;i<data.length;i++){
    data[i] = (data[i]-min)/range;
  }
  return data;
}
function toDataTextureR(heightData, res){
  const arr = new Uint8Array(res*res);
  for(let i=0;i<arr.length;i++) arr[i] = Math.round(THREE.MathUtils.clamp(heightData[i],0,1)*255);
  const tex = new THREE.DataTexture(arr, res, res, THREE.RedFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// 直接用 RawShaderMaterial（inline GLSL，避免 MIME 問題）
const TERRAIN_VERT = /* glsl */`
precision highp float;
uniform sampler2D uHeightTex;
uniform float     uMaxH;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position; in vec2 uv;
out vec2 vUv; out float vH01;
void main(){
  vUv = uv;
  vH01 = texture(uHeightTex, uv).r;
  vec3 pos = position;
  pos.y += vH01 * uMaxH;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos,1.0);
}`;
const TERRAIN_FRAG = /* glsl */`
precision highp float;
in vec2 vUv; in float vH01;
out vec4 fragColor;
vec3 grass(float t){
  vec3 a=vec3(0.09,0.20,0.09);
  vec3 b=vec3(0.18,0.36,0.16);
  vec3 c=vec3(0.46,0.56,0.32);
  float k=clamp(t,0.0,1.0);
  return mix(mix(a,b,k), c, k*k);
}
void main(){
  float h = clamp(vH01,0.0,1.0);
  float slope = clamp(abs(dFdx(h))+abs(dFdy(h)), 0.0, 0.25);
  float shade = 1.0 - slope*0.55;
  float n = fract(sin(dot(vUv, vec2(12.9898,78.233))) * 43758.5453);
  float micro = mix(0.992, 1.010, n);
  vec3 col = grass(h) * shade * micro;
  fragColor = vec4(col,1.0);
}`;

let heightData = null, heightTex = null;
let groundPlane = new THREE.Plane(new THREE.Vector3(0,1,0), 0); // 會在 createTerrain() 內更新

function createTerrain(){
  const res = TERRAIN.res;
  heightData = generateHeight(res, TERRAIN.sizeX, TERRAIN.sizeZ);
  heightTex  = toDataTextureR(heightData, res);

  const geo = new THREE.PlaneGeometry(TERRAIN.sizeX, TERRAIN.sizeZ, res-1, res-1);
  geo.rotateX(-Math.PI*0.5);

  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    uniforms: { uHeightTex:{value:heightTex}, uMaxH:{value:TERRAIN.maxHeight} },
    side: THREE.DoubleSide
  });

  TERRAIN.mesh = new THREE.Mesh(geo, mat);
  TERRAIN.mesh.position.y = TERRAIN.offsetY;
  scene.add(TERRAIN.mesh);

  // 高度/法線查詢
  const halfX=TERRAIN.sizeX*0.5, halfZ=TERRAIN.sizeZ*0.5, resm1=res-1;
  function uvFromXZ(x,z){ return {u:(x+halfX)/TERRAIN.sizeX, v:(z+halfZ)/TERRAIN.sizeZ}; }
  function h01Bilinear(u,v){
    const uu=THREE.MathUtils.clamp(u,0,1), vv=THREE.MathUtils.clamp(v,0,1);
    const xf=uu*resm1, zf=vv*resm1;
    const x0=Math.floor(xf), z0=Math.floor(zf);
    const x1=Math.min(resm1,x0+1), z1=Math.min(resm1,z0+1);
    const tx=xf-x0, tz=zf-z0;
    const idx=(x,z)=> z*res + x;
    const h00=heightData[idx(x0,z0)], h10=heightData[idx(x1,z0)];
    const h01=heightData[idx(x0,z1)], h11=heightData[idx(x1,z1)];
    const hx0=h00*(1-tx)+h10*tx, hx1=h01*(1-tx)+h11*tx;
    return hx0*(1-tz)+hx1*tz;
  }
  TERRAIN.heightAtXZ = (x,z)=>{
    const {u,v}=uvFromXZ(x,z);
    return h01Bilinear(u,v)*TERRAIN.maxHeight + TERRAIN.offsetY;
  };
  TERRAIN.normalAtXZ = (x,z)=>{
    const du = TERRAIN.sizeX / resm1;
    const dv = TERRAIN.sizeZ / resm1;
    const e  = Math.max(du,dv)*0.8;
    const hL=TERRAIN.heightAtXZ(x-e,z), hR=TERRAIN.heightAtXZ(x+e,z);
    const hD=TERRAIN.heightAtXZ(x,z-e), hU=TERRAIN.heightAtXZ(x,z+e);
    let nx=(hL-hR)/(2*e), ny=1.0, nz=(hD-hU)/(2*e);
    if(!Number.isFinite(nx)||!Number.isFinite(ny)||!Number.isFinite(nz)){ nx=0; ny=1; nz=0; }
    return new THREE.Vector3(nx,ny,nz).normalize();
  };

  groundPlane = new THREE.Plane(new THREE.Vector3(0,1,0), -TERRAIN.offsetY);
}
createTerrain();

/* ==========================================================
 * 8) 熱場 — 滑鼠太陽 + 高斯擴散
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

/* 滑鼠投影：優先打地形，失敗再打平面 */
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2(), tempHit = new THREE.Vector3();
function screenToGround(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  let hitXZ = null;
  if (TERRAIN.mesh) {
    const it = raycaster.intersectObject(TERRAIN.mesh, false);
    if (it && it.length) hitXZ = new THREE.Vector2(it[0].point.x, it[0].point.z);
  }
  if (!hitXZ && raycaster.ray.intersectPlane(groundPlane, tempHit)) {
    hitXZ = new THREE.Vector2(tempHit.x, tempHit.z);
  }
  if (hitXZ) Field.sun.pos.copy(hitXZ);
}
window.addEventListener("mousemove", screenToGround);
window.addEventListener("click", (ev) => {
  screenToGround(ev);
  addEmitter(Field.sun.pos.x, Field.sun.pos.y);
  Field.sun.heatPulse += 0.8;
  setTimeout(()=> Field.sun.heatPulse *= 0.6, 250);
});

/* =========================
 * 9) 熱圈可視化（貼地）
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
const HEAT_VIS = { intensity: 2.2, baseRadius: 1.8, ringThickness: 0.2,
  ringColor: new THREE.Color(1.0, 0.85, 0.35), ringColor2: new THREE.Color(1.0, 0.95, 0.8) };
const heatGroup = new THREE.Group(); heatGroup.renderOrder = 9999; scene.add(heatGroup);
const glowTex = makeRadialGlowTexture(512);
const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.8,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1,1), glowMat);
glowPlane.rotation.x = -Math.PI * 0.5; heatGroup.add(glowPlane);
function makeRingMesh(inner, outer, color){
  const geo = new THREE.RingGeometry(inner, outer, 128);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat); mesh.rotation.x = -Math.PI * 0.5; return mesh;
}
const ringOuter = makeRingMesh(0.9, 1.0, HEAT_VIS.ringColor);
const ringInner = makeRingMesh(0.75, 0.85, HEAT_VIS.ringColor2);
heatGroup.add(ringOuter); heatGroup.add(ringInner);
const heatScalePivot = new THREE.Group(); heatGroup.add(heatScalePivot);
heatScalePivot.add(glowPlane); heatScalePivot.add(ringOuter); heatScalePivot.add(ringInner);

function updateHeatVisual() {
  const y = TERRAIN.heightAtXZ(Field.sun.pos.x, Field.sun.pos.y) + 0.01;
  heatGroup.position.set(Field.sun.pos.x, y, Field.sun.pos.y);
  const pulse = THREE.MathUtils.clamp(Field.sun.heatPulse, 0, 3);
  const radius = HEAT_VIS.baseRadius * (0.8 + 0.2 * pulse);
  glowPlane.scale.set(radius*2.0, radius*2.0, 1);
  heatScalePivot.scale.set(radius, 1, radius);
  const bright = HEAT_VIS.intensity * (0.8 + 0.5 * pulse);
  glowMat.opacity = 0.2 * bright;
  ringOuter.material.opacity = 0.35 * Math.min(1.0, 0.35 * bright);
  ringInner.material.opacity = 0.28 * Math.min(1.0, 0.45 * bright);
  const t = THREE.MathUtils.clamp(HEAT_VIS.ringThickness, 0.05, 0.45);
  ringOuter.geometry.dispose(); ringOuter.geometry = new THREE.RingGeometry(1.0 - t*0.35, 1.0, 128);
  ringInner.geometry.dispose(); ringInner.geometry = new THREE.RingGeometry(0.8 - t*0.3, 0.8, 128);
}

/* =========================
 * 10) 物理 + 參數（速度收斂、分離力）
 * ========================= */
const MAX_SPEED=0.9, STEER_GAIN=1.25, SPRING_K=0.35, DAMPING=2.2, YAW_LERP=7.0, MIN_SPEED_EPS=1e-3;
const RHO_GATHER_LOW=0.05, RHO_GATHER_HIGH=0.6;
const OVERHEAT_TEMP=0.8, OVERHEAT_PULSE=0.6, FAR_ACCEL_INNER=4.0, FAR_ACCEL_OUTER=10.0, REPEL_GAIN=3.8;

const HOVER = 0.02;        // ★ 以「腳底為原點」後，只需極小懸空即可
const HEIGHT_LERP = 0.55;  // y 追隨更緊
const SLIDE = 0.92;        // 法線投影去除比例（越小越貼）
const FOOT_CLEAR = 0.003;  // 近似“貼地”，防穿地

// 分離力（避免重疊）
const SEP_RADIUS = 0.8;
const SEP_GAIN   = 0.9;

/* 工具 */
function angleDiff(a,b){const d=b-a;return Math.atan2(Math.sin(d),Math.cos(d));}
function smoothstep(e0,e1,x){const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);}
function yawTowardsVelocity(currYaw,vx,vz,dt){
  const speed=Math.hypot(vx,vz); if(speed<MIN_SPEED_EPS) return currYaw;
  const target=Math.atan2(vx,vz); const d=angleDiff(currYaw,target);
  const rate=1.0-Math.exp(-YAW_LERP*dt); return currYaw+d*rate;
}

/* =========================
 * 11) 動畫更新（貼坡 + 對齊法線 + 分離力）
 * ========================= */
const _dummy = new THREE.Object3D();
const _up = new THREE.Vector3(0,1,0);
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _qTilt = new THREE.Quaternion();
const _qYaw  = new THREE.Quaternion();
const _q     = new THREE.Quaternion();

function clampToTerrainBounds(x,z,margin=0.6){
  const halfX = TERRAIN.sizeX*0.5 - margin;
  const halfZ = TERRAIN.sizeZ*0.5 - margin;
  return { x: THREE.MathUtils.clamp(x, -halfX, halfX),
           z: THREE.MathUtils.clamp(z, -halfZ, halfZ) };
}

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

  // 光暈映射
  const GLOW_INNER = 0.7, GLOW_OUTER = 3.0;

  for (let i = 0; i < COUNT; i++) {
    const { rho, gradX, gradZ, rhoSun, gradSunX, gradSunZ, sunPos } =
      sampleField(perInst.posX[i], perInst.posZ[i], tSec);

    // glow
    let g = (rhoSun - GLOW_INNER) / (GLOW_OUTER - GLOW_INNER);
    g = THREE.MathUtils.clamp(g, 0, 1);
    perInst.glow[i] = g * g * g;

    // ====== 分離力（避免重疊）======
    let sepX = 0, sepZ = 0;
    for (let j=0;j<COUNT;j++){
      if (j===i) continue;
      const dx = perInst.posX[i]-perInst.posX[j];
      const dz = perInst.posZ[i]-perInst.posZ[j];
      const r2 = dx*dx + dz*dz;
      if (r2 < SEP_RADIUS*SEP_RADIUS && r2 > 1e-6) {
        const inv = 1.0 / r2;
        sepX += dx * inv;
        sepZ += dz * inv;
      }
    }

    // ====== 熱源引導/遠距加速/過熱撤離 ======
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

    const gatherBoost = (rho >= RHO_GATHER_LOW && rho <= RHO_GATHER_HIGH) ? 1.35 : 1.0;

    // 施加分離力
    steerX += SEP_GAIN * sepX;
    steerZ += SEP_GAIN * sepZ;

    // 加速度
    let ax = (STEER_GAIN * gatherBoost) * steerX;
    let az = (STEER_GAIN * gatherBoost) * steerZ;
    const bx = positions[i].x, bz = positions[i].z;
    ax += SPRING_K * (bx - perInst.posX[i]);
    az += SPRING_K * (bz - perInst.posZ[i]);
    ax *= mobility; az *= mobility;

    // 積分
    perInst.velX[i] += ax * dt; perInst.velZ[i] += az * dt;

    // === 「貼坡」：移除速度的法線分量，保留切線 ===
    _n.copy(TERRAIN.normalAtXZ(perInst.posX[i], perInst.posZ[i]));
    _v.set(perInst.velX[i], 0, perInst.velZ[i]);
    const vn = _n.dot(_v);
    _v.addScaledVector(_n, -vn * SLIDE); // 去掉朝上/下的份量，避免飛起或鑽地
    perInst.velX[i] = _v.x; perInst.velZ[i] = _v.z;

    // 衰減 + 限速
    const damp = Math.exp(-DAMPING * dt);
    perInst.velX[i] *= damp; perInst.velZ[i] *= damp;
    const speed = Math.hypot(perInst.velX[i], perInst.velZ[i]);
    if (speed > MAX_SPEED) { const s = MAX_SPEED / speed; perInst.velX[i] *= s; perInst.velZ[i] *= s; }

    // 位置更新 + 邊界夾取
    let nx = perInst.posX[i] + perInst.velX[i] * dt;
    let nz = perInst.posZ[i] + perInst.velZ[i] * dt;
    const cl = clampToTerrainBounds(nx, nz, 0.8);
    perInst.posX[i] = cl.x;
    perInst.posZ[i] = cl.z;

    // y 追隨地形 + 微小跳動（以腳底=0 設計，幾乎貼地）
    const terrainY = TERRAIN.heightAtXZ(perInst.posX[i], perInst.posZ[i]);
    const targetBase = terrainY; // 腳底直接落在地表
    const baseY = THREE.MathUtils.lerp(perInst.baseY[i], targetBase, HEIGHT_LERP);
    perInst.baseY[i] = baseY;

    // 朝向（沿法線的 yaw）
    perInst.yaw[i] = yawTowardsVelocity(perInst.yaw[i], perInst.velX[i], perInst.velZ[i], dt);

    const ph = perInst.phase0[i] + perInst.freq[i] * mobility * tSec * Math.PI * 2.0;
    const s = 0.5 + 0.5 * Math.sin(ph);
    const yHop = (HOVER + FOOT_CLEAR) + 0.04 * s * (1.0 - s) * perInst.ampY[i];

    const yFinal = Math.max(baseY + yHop, terrainY + FOOT_CLEAR);

    // 對齊法線 → 再繞法線 yaw（不會側翻穿地）
    _qTilt.setFromUnitVectors(_up, _n);
    _qYaw.setFromAxisAngle(_n, perInst.yaw[i]);
    _q.copy(_qTilt).multiply(_qYaw);

    // 輕微擠壓（腳底原點，縮放只往上）
    const contactBand = 0.18, squashAmp = 0.16 * mobility;
    const contactWeight = 1 - smoothstep(0.0, contactBand, s);
    const squash = squashAmp * contactWeight;
    const sy  = 1.0 - squash, sxz = 1.0 + squash * 0.75;

    _dummy.position.set(perInst.posX[i], yFinal, perInst.posZ[i]);
    _dummy.quaternion.copy(_q);
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
  composer.render();
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
