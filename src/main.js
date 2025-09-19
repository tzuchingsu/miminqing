import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

// ✅ src/shaders/ 에서 읽어오는 버전 (index.html이 루트)
async function loadShaders() {
  const base = import.meta.url; // /src/main.js 의 절대 URL

  const withBust = (rel) => {
    const u = new URL(rel, base);
    u.searchParams.set("v", Date.now().toString()); // 캐시 방지
    return u;
  };

  const urls = [
    withBust("./shaders/terrain.vertex.glsl"),
    withBust("./shaders/terrain.fragment.glsl"),
    withBust("./shaders/water.vertex.glsl"),
    withBust("./shaders/water.fragment.glsl"),
    withBust("./shaders/depth.inject.common.glsl"),
    withBust("./shaders/depth.inject.begin_vertex.glsl"),
  ];

  const texts = await Promise.all(
    urls.map(u =>
      fetch(u).then(r => {
        if (!r.ok) throw new Error(`Fetch failed ${u}: ${r.status}`);
        return r.text();
      })
    )
  );

  return {
    terrainVert: texts[0],
    terrainFrag: texts[1],
    waterVert:   texts[2],
    waterFrag:   texts[3],
    depthCommon: texts[4],
    depthBegin:  texts[5],
  };
}

async function boot() {
  const { terrainVert, terrainFrag, waterVert, waterFrag, depthCommon, depthBegin } = await loadShaders();

  // ---------- Renderer / Scene / Camera ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0xffffff, 1);
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xffffff, 0.002);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(22, 18, 22);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // ---------- Lights ----------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x668899, 0.6);
  hemi.position.set(0, 50, 0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.95);
  dir.position.set(18, 28, 14);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 120;
  const s = 60;
  dir.shadow.camera.left = -s; dir.shadow.camera.right = s;
  dir.shadow.camera.top  =  s; dir.shadow.camera.bottom = -s;
  scene.add(dir);

  // ---------- Terrain ----------
  const W = 140, H = 140, SEGX = 420, SEGY = 420;
  const groundGeo = new THREE.PlaneGeometry(W, H, SEGX, SEGY);
  groundGeo.rotateX(-Math.PI / 2);

  const groundMat = new THREE.ShaderMaterial({
    uniforms: {
      // fBm 기본
      uScale:        { value: 0.65 },
      uAmp:          { value: 13.0 },
      uOctaves:      { value: 7     },
      uLacunarity:   { value: 2.0   },
      uGain:         { value: 0.45  },
      uGrow:         { value: 1.0   },

      // A: Terrace fBm (HEIGHT)
      uAScale:        { value: 0.20 },
      uATerraceSteps: { value: 6.0  },

      // B: OpenSimplex (MASK)
      uBScale:    { value: 0.20 },
      uBThreshLo: { value: 0.40 },
      uBThreshHi: { value: 0.60 },

      // 협곡 & 강
      uRimGain:      { value: 0.20 },
      uRiverWidth:   { value: 3.8  },
      uRiverFeather: { value: 0.25 },
      uRiverBase:    { value: -0.55 },

      // 색/빛
      uColGrass:  { value: new THREE.Color(0x7bb66f) },
      uColForest: { value: new THREE.Color(0x1f3a29) },
      uColRock:   { value: new THREE.Color(0x2e4a3f) },
      uColRiver:  { value: new THREE.Color(0x2a9ec2) },
      uLightDir:  { value: new THREE.Vector3(0.6, 1.0, 0.5).normalize() },

      // 수동 안개
      uFogDensity:   { value: 0.00008 }
    },
    vertexShader: terrainVert,
    fragmentShader: terrainFrag,
    side: THREE.FrontSide
  });

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.castShadow = true;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- Depth material (쉐도우 튐 방지) ----------
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMat.onBeforeCompile = (shader)=>{
    // terrain과 동일 uniforms 공유
    shader.uniforms.uScale        = groundMat.uniforms.uScale;
    shader.uniforms.uAmp          = groundMat.uniforms.uAmp;
    shader.uniforms.uGrow         = groundMat.uniforms.uGrow;
    shader.uniforms.uOctaves      = groundMat.uniforms.uOctaves;
    shader.uniforms.uLacunarity   = groundMat.uniforms.uLacunarity;
    shader.uniforms.uGain         = groundMat.uniforms.uGain;
    shader.uniforms.uAScale       = groundMat.uniforms.uAScale;
    shader.uniforms.uATerraceSteps= groundMat.uniforms.uATerraceSteps;
    shader.uniforms.uBScale       = groundMat.uniforms.uBScale;
    shader.uniforms.uBThreshLo    = groundMat.uniforms.uBThreshLo;
    shader.uniforms.uBThreshHi    = groundMat.uniforms.uBThreshHi;
    shader.uniforms.uRimGain      = groundMat.uniforms.uRimGain;
    shader.uniforms.uRiverWidth   = groundMat.uniforms.uRiverWidth;
    shader.uniforms.uRiverFeather = groundMat.uniforms.uRiverFeather;
    shader.uniforms.uRiverBase    = groundMat.uniforms.uRiverBase;

    // three 내장 depth vertex shader에 문자열로 주입
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${depthCommon}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${depthBegin}`);
  };
  ground.customDepthMaterial = depthMat;

  // ---------- Water ----------
  const riverWidthWorld = 2.0 * groundMat.uniforms.uRiverWidth.value / groundMat.uniforms.uScale.value;
  const waterGeo = new THREE.PlaneGeometry(riverWidthWorld, H, 200, 200);
  waterGeo.rotateX(-Math.PI / 2);

  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:     { value: 0.0 },
      uWaveAmp:  { value: 0.08 },
      uWaveFreq: { value: 3.0 },
      uWaveSpeed:{ value: 1.2 },
      uCol:      { value: new THREE.Color(0x6dc0d6) }
    },
    vertexShader: waterVert,
    fragmentShader: waterFrag,
    transparent: true
  });

  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(
    0,
    groundMat.uniforms.uRiverBase.value * groundMat.uniforms.uAmp.value * groundMat.uniforms.uGrow.value + 0.02,
    0
  );
  water.receiveShadow = true;
  scene.add(water);

  // ---------- Resize & Animate ----------
  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  function animate(){
    controls.update();
    waterMat.uniforms.uTime.value = performance.now() / 1000.0;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
}

boot().catch(err => console.error(err));
