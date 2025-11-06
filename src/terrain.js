// src/terrain.js

import * as THREE from "three";

/* ---------------- GLSL 로더 (라이트 셰이더 전제) ---------------- */

async function loadShader(url) {

const res = await fetch(url);

return await res.text();

}

/* ---------------- JS-side value-noise / perlin ------------------- */

function fract(x) { return x - Math.floor(x); }

function hash2(x, y) {

const d = x * 127.1 + y * 311.7;

return fract(Math.sin(d) * 43758.5453123);

}

function valueNoise2(x, y) {

const ix = Math.floor(x), iy = Math.floor(y);

const fx = x - ix,       fy = y - iy;

const a = hash2(ix,     iy    );

const b = hash2(ix + 1, iy    );

const c = hash2(ix,     iy + 1);

const d = hash2(ix + 1, iy + 1);

const ux = fx * fx * (3 - 2 * fx);

const uy = fy * fy * (3 - 2 * fy);

return (a * (1 - ux) + b * ux) +

(c - a) * uy * (1 - ux) +

(d - b) * ux * uy;

}

function perlin2(x, y) {

let n = 0.0, amp = 0.5, freq = 1.0;

for (let i = 0; i < 4; i++) {

n += amp * valueNoise2(x * freq, y * freq);

freq *= 2.0;

amp *= 0.5;

}

return n * 2.0 - 1.0; // [0,1] → [-1,1]

}

/* ---------------- CPU에서 지형 변형 ------------------------------- */

function displaceGeometryCPU(geometry, amp, freq) {

const pos = geometry.attributes.position;

for (let i = 0; i < pos.count; i++) {

const x = pos.getX(i);

const z = pos.getZ(i);

const n = perlin2(x * freq, z * freq);

pos.setY(i, n * amp);

}

pos.needsUpdate = true;

geometry.computeVertexNormals();

geometry.computeBoundingSphere();

geometry.computeBoundingBox();

}

/* ---------------- 샘플러: 로컬/월드 ------------------------------- */

function makeHeightSamplerLocal(AMP, FREQ) {

const E = 1.0; // 기울기 근사 간격(로컬)

return function heightAtLocal(x, z) {

const n  = perlin2(x * FREQ, z * FREQ);

const h  = n * AMP;

const hX = perlin2((x + E) * FREQ, z * FREQ) * AMP;

const hZ = perlin2(x * FREQ, (z + E) * FREQ) * AMP;

const dhdx = hX - h, dhdz = hZ - h;

const nx = -dhdx, ny = 1.0, nz = -dhdz;

const inv = 1.0 / Math.hypot(nx, ny, nz);

return {

point: new THREE.Vector3(x, h, z),

normal: new THREE.Vector3(nx * inv, ny * inv, nz * inv),

};

};

}

function makeHeightSamplerWorld(root, AMP, FREQ) {

const localSampler = makeHeightSamplerLocal(AMP, FREQ);

const normalMat = new THREE.Matrix3();

return function heightAtWorld(xw, zw) {

// 월드 → 로컬

const pL = new THREE.Vector3(xw, 0, zw);

root.worldToLocal(pL);

// 로컬 샘플

const resL = localSampler(pL.x, pL.z);

// 로컬 → 월드

const pW = resL.point.clone();

root.localToWorld(pW);

normalMat.getNormalMatrix(root.matrixWorld);

const nW = resL.normal.clone().applyMatrix3(normalMat).normalize();

return { point: pW, normal: nW };

};

}

/* ---------------- createTerrain ------------------------------- */

export async function createTerrain({

size = 200,

segments = 128, // 성능 기본값

AMP = 20.0,

FREQ = 0.04,

vertPath = "./src/shaders/terrain.vert.glsl",

fragPath = "./src/shaders/terrain.frag.glsl",

} = {}) {

const vertSrc = await loadShader(vertPath);

const fragSrc = await loadShader(fragPath);

// 공통 형상

const baseGeom = new THREE.PlaneGeometry(size, size, segments, segments);

baseGeom.rotateX(-Math.PI * 0.5);

displaceGeometryCPU(baseGeom, AMP, FREQ);

// 콜라이더

const colGeom = baseGeom.clone();

const colMat = new THREE.MeshBasicMaterial({

color: 0x00ffff,

wireframe: false,

visible: false, // 디버그 시 true

});

const collider = new THREE.Mesh(colGeom, colMat);

collider.name = "TerrainCollider";

// 시각용 (라이트 셰이더)

const visGeom = baseGeom.clone();

const visMat = new THREE.ShaderMaterial({

vertexShader: vertSrc,

fragmentShader: fragSrc,

uniforms: {

uTime: { value: 0.0 }, // 색/미세효과만

},

fog: false,

});

const visual = new THREE.Mesh(visGeom, visMat);

visual.name = "TerrainVisual";

// 그룹

const root = new THREE.Group();

root.name = "TerrainRoot";

root.add(visual);

root.add(collider);

// 샘플러 주입

root.userData = {

visual,

collider,

AMP,

FREQ,

size,

segments,

heightSamplerLocal: makeHeightSamplerLocal(AMP, FREQ),

heightSamplerWorld: null,

};

root.userData.heightSamplerWorld = makeHeightSamplerWorld(root, AMP, FREQ);

console.log("[terrain] sampler ready:", { size, segments, AMP, FREQ });

return root;

}

/* ---------------- 시간 업데이트(선택) ------------------------------ */

export function updateTerrainTime(terrainRoot, dt) {

const visual = terrainRoot?.userData?.visual;

if (visual?.material?.uniforms?.uTime) {

visual.material.uniforms.uTime.value += dt;

}

}