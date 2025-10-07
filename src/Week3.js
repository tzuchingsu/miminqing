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

// 4) GLB 불러오기
const loader = new GLTFLoader();
loader.load(
  "./assets/models/newmi.glb", // 🔹 학생마다 자기 GLB 경로 넣기
  (gltf) => scene.add(gltf.scene),
  undefined,
  (err) => console.error("GLB load error:", err)
);

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