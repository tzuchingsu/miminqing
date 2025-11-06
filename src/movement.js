// src/movement.js

import * as THREE from "three";

/** ---------------- 파라미터 ---------------- */

export const movementParams = {

moveSpeed: 6.0,            // 수평 속도 (m/s)

stopDist: 0.08,            // 도착 판정 (XZ)

rotateSpeed: 7.0,          // 회전 보간 속도

slopeAlignFactor: 0.9,     // 1 = 법선 완전 추종

heightLerp: 14.0,          // y 보정 속도

extraSurfaceOffset: 0.10,  // 기본 띄움

groundRadius: 0.15,        // 경사 추가 띄움

maxHorizStep: 2.0,         // 프레임 드랍 시 급가속 방지

castAbove: 200.0,          // (피킹용) 위에서 아래 레이

clickButton: 0,            // 좌클릭

};

let camera, renderer, terrainRoot, characterRoot;

// 상태

let hasTarget = false;

const targetPos = new THREE.Vector3();

let footOffset = 0.1;

// 피킹용 레이캐스터(클릭 때만)

const raycaster = new THREE.Raycaster();

const mouseNDC  = new THREE.Vector2();

// 폴백용 아래 레이

const downRay = new THREE.Raycaster();

// 콜라이더 목록(피킹/폴백용)

let TERRAIN_TARGETS = [];

// 지면 샘플러(월드)

let heightSampler = null;

const tmpV3 = new THREE.Vector3();

const tmpQ  = new THREE.Quaternion();

const lookDummy = new THREE.Object3D();

/* ---------------- 유틸 ---------------- */

function setMouseNDCFromEvent(e) {

const r = renderer.domElement.getBoundingClientRect();

mouseNDC.set(

((e.clientX - r.left) / r.width) * 2 - 1,

-((e.clientY - r.top) / r.height) * 2 + 1

);

}

function buildTerrainTargets(root) {

TERRAIN_TARGETS.length = 0;

if (root?.userData?.collider?.isMesh) TERRAIN_TARGETS.push(root.userData.collider);

root.traverse(o => { if (o?.isMesh && !TERRAIN_TARGETS.includes(o)) TERRAIN_TARGETS.push(o); });

}

function computeFootOffsetFromBBox(obj3D) {

const box = new THREE.Box3().setFromObject(obj3D);

if (box.isEmpty()) return 0.5;

return Math.max(0.0, -box.min.y);

}

function findFirstMesh(o) {

let m = null; o.traverse(c => { if (!m && c.isMesh) m = c; });

return m || o;

}

/* ---------------- 클릭 피킹(레이캐스트는 여기서만) --------------- */

function pickTerrainPointFromCamera() {

raycaster.setFromCamera(mouseNDC, camera);

// 1) 콜라이더 우선

let hit = raycaster.intersectObjects(TERRAIN_TARGETS, false)[0];

if (hit) return hit.point.clone();

// 2) 폴백: 루트 전체

hit = raycaster.intersectObject(terrainRoot, true)[0];

if (hit) return hit.point.clone();

return null;

}

function onPointerDown(e) {

if (e.button !== movementParams.clickButton) return;

console.log("[pointer]", e.type, e.clientX, e.clientY); // 디버그

setMouseNDCFromEvent(e);

const p = pickTerrainPointFromCamera();

if (!p) {

console.warn("[pick] no hit");

return;

}

// 목표는 XZ만 사용(높이는 매프레임 샘플러로 결정)

targetPos.set(p.x, 0, p.z);

hasTarget = true;

console.log("[movement] target set:", targetPos.x.toFixed(2), targetPos.z.toFixed(2));

}

/* ---------------- 공개 API ---------------- */

export function initMovement(opts) {

({ camera, renderer, terrainRoot, characterRoot } = opts);

if (opts?.opts) Object.assign(movementParams, opts.opts);

buildTerrainTargets(terrainRoot);

heightSampler = terrainRoot?.userData?.heightSamplerWorld

|| terrainRoot?.userData?.heightSampler

|| null;

if ("firstHitOnly" in raycaster) raycaster.firstHitOnly = true;

raycaster.near = 0.01;

raycaster.far  = movementParams.castAbove + 5.0;

footOffset = computeFootOffsetFromBBox(findFirstMesh(characterRoot));

console.log("[movement] heightSampler:", !!heightSampler,

"AMP/FREQ:", terrainRoot?.userData?.AMP, terrainRoot?.userData?.FREQ);

renderer.domElement.addEventListener("pointerdown", onPointerDown, { passive: true });

}

export function setTargetPosition(v3) { targetPos.copy(v3); hasTarget = true; }

if (typeof window !== "undefined") window.setTargetPosition = setTargetPosition;

/* ---------------- 폴백: 레이캐스트로 y/노멀 얻기 ------------------ */

function sampleGroundFallback(x, z) {

const startY = movementParams.castAbove;

tmpV3.set(x, startY, z);

downRay.set(tmpV3, new THREE.Vector3(0,-1,0));

const hit = downRay.intersectObjects(TERRAIN_TARGETS, false)[0];

if (!hit) return null;

const n = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0,1,0);

hit.object.updateMatrixWorld(true);

n.transformDirection(hit.object.matrixWorld).normalize();

return { point: hit.point.clone(), normal: n };

}

/* ---------------- 매프레임: 샘플러로 높이 붙이기 ------------------ */

export function updateMovement(dt) {

if (!characterRoot) return;

const cur = characterRoot.position;

// 1) 목표 수평 스텝

let step = new THREE.Vector3();

if (hasTarget) {

step.copy(targetPos).sub(cur);

if (Math.hypot(step.x, step.z) <= movementParams.stopDist) {

hasTarget = false;

step.set(0, 0, 0);

}

}

step.y = 0;

// 프레임 드랍 시 급가속 방지

const maxStep = Math.min(movementParams.maxHorizStep, movementParams.moveSpeed * dt);

const len = Math.hypot(step.x, step.z);

if (len > 1e-8) step.multiplyScalar(Math.min(1.0, maxStep / len));

const nextX = cur.x + step.x;

const nextZ = cur.z + step.z;

// console.log("stepXZ:", step.x.toFixed(3), step.z.toFixed(3)); // 디버그

// 2) 지면 샘플러(월드) → 폴백 순서

let hit = heightSampler ? heightSampler(nextX, nextZ) : null;

if (!hit) hit = sampleGroundFallback(nextX, nextZ);

if (!hit) {

// 샘플 실패: XZ만 이동

cur.x = nextX; cur.z = nextZ;

return;

}

// console.log("y@", nextX.toFixed(2), nextZ.toFixed(2), "->", hit.point.y.toFixed(2)); // 디버그

// 3) 표면 고정: hit.point + n * (footOffset + extra + slopeLift)

const n = hit.normal;

const slopeLift = movementParams.groundRadius * (1.0 - THREE.MathUtils.clamp(n.y, 0.0, 1.0));

const surfOffset = footOffset + movementParams.extraSurfaceOffset + slopeLift;

const desiredY = hit.point.y + n.y * surfOffset;

const alpha = THREE.MathUtils.clamp(movementParams.heightLerp * dt, 0, 1);

// XZ는 즉시, Y는 부드럽게

cur.x = hit.point.x;

cur.z = hit.point.z;

cur.y = THREE.MathUtils.lerp(cur.y, desiredY, alpha);

// 4) 회전 안정화

applyRotation(cur, step, n, dt);

}

/* ---------------- 회전 보정 ---------------- */

function applyRotation(curPos, stepVec, groundNormal, dt) {

let dir = stepVec.clone();

if (dir.lengthSq() < 1e-10) {

dir.set(0, 0, 1).applyQuaternion(findWorldQuat(characterRoot));

dir.y = 0;

} else {

dir.normalize();

}

const upMixed = new THREE.Vector3(0, 1, 0)

.lerp(groundNormal, movementParams.slopeAlignFactor)

.normalize();

lookDummy.position.copy(curPos);

lookDummy.up.copy(upMixed);

lookDummy.lookAt(curPos.x + dir.x, curPos.y + dir.y, curPos.z + dir.z);

tmpQ.copy(lookDummy.quaternion);

characterRoot.quaternion.slerp(tmpQ, Math.min(1.0, movementParams.rotateSpeed * dt));

}

function findWorldQuat(obj) {

obj.updateWorldMatrix(true, false);

const q = new THREE.Quaternion();

obj.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());

return q;

}