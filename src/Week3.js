import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// 1) 기본 세팅
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(2, 2, 4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// 2) 조명
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
scene.add(new THREE.DirectionalLight(0xffffff, 1));

// 3) 컨트롤
const controls = new OrbitControls(camera, renderer.domElement);

// ✅ 1) PNG → 파워오브투 텍스처로 변환 (repeat/mipmap용)
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

// RD.png 불러오기
// ✅ 2) RD.png 로드 → MeshStandardMaterial 생성
let rdMat = null;
let modelLoaded = null;

const texLoader = new THREE.TextureLoader();
texLoader.load("./assets/textures/RD.png", (tex) => {
  const rdPOT = toPOTTexture(tex.image, 1024); // 1024x1024로 리샘플

  rdMat = new THREE.MeshStandardMaterial({
    map: rdPOT,
    metalness: 0.0,
    roughness: 1.0,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.5,
    depthWrite: true,
  });

  // 원하는 타일 수
  rdMat.map.repeat.set(1, 1);
  rdMat.map.needsUpdate = true;

  // 모델이 먼저 로드된 경우 즉시 적용
  if (modelLoaded) applyRDToNamedMeshes(modelLoaded);
});

// ✅ 3) GLB 로드 → 로드 완료 시 해당 이름의 메쉬에 적용 시도
const loader = new GLTFLoader();
loader.load("./assets/models/newmi.glb", (gltf) => {
  modelLoaded = gltf.scene;
  scene.add(modelLoaded);

  // 텍스처/머티리얼이 이미 준비된 경우 즉시 적용
  if (rdMat) applyRDToNamedMeshes(modelLoaded);
});

// ✅ 4) 이름으로 타겟 메쉬 찾아 머티리얼 적용 (정규식 매칭)
function applyRDToNamedMeshes(root) {
  const hits = [];
  root.traverse((o) => {
    if (!o.isMesh) return;

    // 여기서 메쉬 이름 조건을 필요에 맞게 수정하세요.
    const isTarget =
      /Mycocurator(\.\d+)?/i.test(o.name); // ex) LegBall, leg-ball, leg ball.002

    if (isTarget) {
      o.material = rdMat;
      o.castShadow = o.receiveShadow = true;
      hits.push(o.name);
    }
  });
  console.log(`RD applied count: ${hits.length}`, hits);
}

// 5) 리사이즈 & 루프
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();