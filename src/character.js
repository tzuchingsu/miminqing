// src/character.js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

/** 路徑（請確認檔名存在） */
const MODEL_URL = "assets/models/newmi.glb";
const RD_TEXTURE_URL = "assets/textures/RD.png";

/** 目標高度（統一比例） */
const TARGET_HEIGHT_UNITS = 2.0;

/* ────────────────────────────────
 * 工具：將模型底部對齊 y=0 & 中心置中
 * ──────────────────────────────── */
function alignToGroundAndCenter(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  model.position.set(-center.x, -box.min.y, -center.z);
  return size;
}

function scaleToTargetHeight(model, targetHeight) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y > 0) {
    const s = targetHeight / size.y;
    model.scale.setScalar(s);
  }
}

/* ────────────────────────────────
 * 將 RD 紋理掛在 emissiveMap 上，做出發光裂紋
 * ──────────────────────────────── */
function applyRDToEmissive(obj, rdTexture) {
  obj.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      if ("emissive" in m) {
        m.emissive = new THREE.Color(0xffffff);
        m.emissiveMap = rdTexture;      // 裂紋圖當發光貼圖
        m.emissiveIntensity = 1.5;      // 基礎亮度
        m.needsUpdate = true;
      }
    }
  });
}

/* ────────────────────────────────
 * 只載一次原型，之後 clone
 * ──────────────────────────────── */
let _prototype = null;

/** 讀取 GLB + RD 紋理並處理完成回傳原型 */
async function loadPrototype() {
  if (_prototype) return _prototype;

  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  const [scene, rdTexture] = await Promise.all([
    loader.loadAsync(MODEL_URL).then(g => g.scene),
    new Promise((resolve, reject) => {
      texLoader.load(RD_TEXTURE_URL, resolve, undefined, reject);
    }),
  ]);

  // RD 紋理設定
  rdTexture.wrapS = rdTexture.wrapT = THREE.RepeatWrapping;
  rdTexture.minFilter = THREE.LinearFilter;
  rdTexture.magFilter = THREE.LinearFilter;

  // 尺寸歸一化 + 底對齊地面
  const size = alignToGroundAndCenter(scene);
  if (size.y > 0) {
    scaleToTargetHeight(scene, TARGET_HEIGHT_UNITS);
    alignToGroundAndCenter(scene);
  }

  // 套上發光裂紋
  applyRDToEmissive(scene, rdTexture);

  scene.name = "ThermoBugPrototype";
  _prototype = scene;
  console.log("%c[character] ✅ ThermoBug 原型載入完成", "color:#4CAF50");
  return _prototype;
}

/** 對外：characterRoot（Promise 解析為 Group，內含一隻原型） */
export const characterRoot = (async () => {
  const proto = await loadPrototype();
  const group = new THREE.Group();
  group.name = "CharacterRoot";
  group.add(proto);
  return group;
})();

/** 對外：深拷貝一隻（支援 SkinnedMesh 骨架） */
export function cloneCharacter(prototypeOrGroup) {
  // 可傳入 prototype 或含有 prototype 的 group.child
  const node = prototypeOrGroup?.isGroup && prototypeOrGroup.children?.length
    ? prototypeOrGroup.children[0]
    : prototypeOrGroup;
  const inst = SkeletonUtils.clone(node);
  inst.name = "ThermoBug";
  return inst;
}
