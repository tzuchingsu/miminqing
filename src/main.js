import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
// WHERE TO PLACE: 바로 아래 줄 ⬇⬇⬇
// import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

let GUI;
try {
  // import map 경로 우선
  ({ GUI } = await import("three/examples/jsm/libs/lil-gui.module.min.js"));
} catch (e) {
  // 폴백: CDN 절대경로
  ({ GUI } = await import("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/lil-gui.module.min.js"));
}


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
  scene.add(camera);

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

  // ===== Height RT 초기 굽기(bake) 시작 =====
// ------ RenderTarget 생성 (여기서 해상도 한 줄만 바꾸면 됨) ------
const HEIGHT_RT_W = 1024; // 여기서 한 줄만 바꾸면 됨 (해상도)
const HEIGHT_RT_H = 1024;

const heightRT = new THREE.WebGLRenderTarget(HEIGHT_RT_W, HEIGHT_RT_H, {
  depthBuffer: false,
  stencilBuffer: false,
  type: THREE.HalfFloatType, // 더 부드러운 높이 (필요시 UnsignedByteType으로 변경 가능)
  format: THREE.RGBAFormat
});
heightRT.texture.colorSpace = THREE.NoColorSpace; // ★ 중요: 마스크/높이/노멀은 NoColorSpace

// WHERE TO REPLACE: 기존 fsPassVS 정의 전체를 이걸로 교체
const fsPassVS = /* glsl */`
precision highp float;
void main() {
  // three가 position/uv 등 attribute를 이미 주입하므로 재선언 금지!
  gl_Position = vec4(position, 1.0);
}
`;

// height.frag.glsl를 개별로 로드 (캐시 방지 쿼리 포함)
const hURL = new URL("./shaders/height.frag.glsl", import.meta.url);
hURL.searchParams.set("v", Date.now().toString());
const heightFragSrc = await fetch(hURL).then(r => {
  if (!r.ok) throw new Error("Failed to load height.frag.glsl");
  return r.text();
});

// 풀스크린 렌더링 세트
const fsScene = new THREE.Scene();
const fsCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fsQuad  = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: {
      uResolution: { value: new THREE.Vector2(HEIGHT_RT_W, HEIGHT_RT_H) },
      uSeed:       { value: Math.random() * 1000.0 }, // 여기서 한 줄만 바꾸면 됨 (초기 시드)
      uSeaLevel:   { value: 0.50 }                     // 여기서 한 줄만 바꾸면 됨 (해수면)
    },
    vertexShader:   fsPassVS,
    fragmentShader: heightFragSrc,
    depthTest:  false,
    depthWrite: false
  })
);
fsScene.add(fsQuad);


// 머티리얼 핸들, 나중에 reseed에서 접근
const heightMat = fsQuad.material;

// 최초 굽기(bake)
renderer.setRenderTarget(heightRT);
renderer.render(fsScene, fsCam);
renderer.setRenderTarget(null);

// ===== Terrain Masks RT 초기 굽기(bake) 시작 =====
// terrainMasks.frag.glsl 로드 (캐시 방지)
const tmURL = new URL("./shaders/terrainMasks.frag.glsl", import.meta.url);
tmURL.searchParams.set("v", Date.now().toString());
const terrainMasksFragSrc = await fetch(tmURL).then(r => {
  if (!r.ok) throw new Error("Failed to load terrainMasks.frag.glsl");
  return r.text();
});

// RenderTarget 생성 (Height와 동일 해상도 권장)
const MASKS_RT_W = HEIGHT_RT_W; // 여기서 한 줄만 바꾸면 됨 (해상도)
const MASKS_RT_H = HEIGHT_RT_H;

const terrainMasksRT = new THREE.WebGLRenderTarget(MASKS_RT_W, MASKS_RT_H, {
  depthBuffer: false,
  stencilBuffer: false,
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat
});
terrainMasksRT.texture.colorSpace = THREE.NoColorSpace; // ★ 중요: 분석 마스크는 NoColorSpace

// 풀스크린 패스 (vUv 불필요: gl_FragCoord*texel 사용)
const masksScene = new THREE.Scene();
const masksCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const masksQuad  = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: {
      heightTex:  { value: heightRT.texture },                 // Height 소스(R 채널)
      texel:      { value: new THREE.Vector2(1/MASKS_RT_W, 1/MASKS_RT_H) }, // 중앙차분 텍셀 크기
      slopeScale: { value: 6.0 },                            // 여기서 한 줄만 (기울기 스케일)
      curvScale:  { value: 20.0 }                              // 여기서 한 줄만 (곡률 스케일)
    },
    vertexShader: fsPassVS,            // vUv 없는 버전 → frag에서 gl_FragCoord*texel 경로 사용
    fragmentShader: terrainMasksFragSrc,
    depthTest: false,
    depthWrite: false
  })
);
masksScene.add(masksQuad);

// 머티리얼 핸들 보관 (GUI에서 사용)
const terrainMasksMat = masksQuad.material;

// --- GUI 인스턴스는 모든 gui.add(...)보다 먼저 만들어야 함
const gui = new GUI({ title: "Terrain Masks" });
gui.show(); // 필요 없으면 지워도 됨

// --- 여러 곳에서 쓰는 모드 맵 (먼저 선언해두기)
const mapMode = { Height:0, Slope:1, Curvature:2, Aspect:3, Composite:4 };

// 최초 굽기(bake)
renderer.setRenderTarget(terrainMasksRT);
renderer.render(masksScene, masksCam);
renderer.setRenderTarget(null);

// (선택) 디버그: 지금 화면으로 바로 보고 싶으면 아래 사용
// const debugMat = new THREE.MeshBasicMaterial({ map: terrainMasksRT.texture });
// const debugPlane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), debugMat);
// debugPlane.position.set(-W*0.4, 5, -H*0.4); scene.add(debugPlane);

// 나중에 사용할 수 있도록 참조(예: groundMat.uniforms.masksTex 등)
// groundMat.uniforms.masksTex = { value: terrainMasksRT.texture };
// ===== Terrain Masks RT 초기 굽기(bake) 끝 =====
// WHERE TO PLACE: 바로 아래 줄 ⬇⬇⬇
// // ===== Terrain Masks RT 초기 굽기(bake) 끝 =====
// === [ADD] 지형용 마스크 뷰어 머티리얼들 =====================
// === 지형 변형을 그대로 쓰는 '마스크 보기' 머티리얼 ===
// groundMat과 동일 vertexShader/동일 uniforms를 공유하고,
// fragment 에서만 마스크 텍스처를 컬러링해서 출력.

const MASK_VIEW_FS_3D = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform sampler2D masksTex; // RGBA: H,S,C,A (0..1)
uniform float uMode;        // 0:H, 1:S, 2:C, 3:A, 4:Composite
uniform float gainH;
uniform float gainS;
uniform float gainC;
uniform float gammaH;

// HSV → RGB (Aspect 컬러링)
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

void main(){
  vec4 m = texture2D(masksTex, vUv);
  float h = pow(clamp(m.r * gainH, 0.0, 1.0), gammaH);
  float s = clamp(m.g * gainS, 0.0, 1.0);
  float c = clamp(0.5 + (m.b - 0.5) * gainC, 0.0, 1.0);
  float a = m.a;

  vec3 outCol;
  if (uMode < 0.5)      outCol = vec3(h);
  else if (uMode < 1.5) outCol = vec3(s);
  else if (uMode < 2.5) outCol = vec3(c);
  else if (uMode < 3.5) outCol = hsv2rgb(vec3(a, 1.0, 1.0));
  else                  outCol = vec3(h,s,c); // Composite

  gl_FragColor = vec4(outCol, 1.0);
}
`;

// groundMat과 같은 정점 변형을 '그대로' 사용
const maskOverlayMat = new THREE.ShaderMaterial({
  uniforms: Object.assign(
    // 지형과 동일한 변형/노이즈 파이프를 공유해야 지표가 같아집니다
    THREE.UniformsUtils.clone(groundMat.uniforms),
    {
      masksTex: { value: terrainMasksRT.texture },
      uMode:    { value: 4.0 },
      gainH:    { value: 1.0 },
      gainS:    { value: 1.0 },
      gainC:    { value: 1.0 },
      gammaH:   { value: 1.2 }
    }
  ),
  vertexShader: terrainVert,        // ★ 지형과 동일한 정점 셰이더
  fragmentShader: MASK_VIEW_FS_3D,  // ★ 색만 교체
  side: THREE.FrontSide,
  depthTest: true,
  depthWrite: true,
  transparent: false,
  toneMapped: false
});

// 마스크 텍스처는 색공간 보정 없이
maskOverlayMat.uniforms.masksTex.value.colorSpace = THREE.NoColorSpace;

// RGBA 그대로 보기 (R=H,G=S,B=C,A=Aspect의 A는 컬러로는 안 보임)
// -> 그냥 텍스처 그대로 칠함
const maskRGBA_Mat = new THREE.MeshBasicMaterial({
  map: terrainMasksRT.texture,
  toneMapped: false
});
maskRGBA_Mat.map.colorSpace = THREE.NoColorSpace;

// 채널별 흑백/Aspect-컬러 뷰어 (UV가 필요하므로 간단 셰이더 사용)
const MASK_VIEW_VS = /* glsl */`
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  }
`;

const MASK_VIEW_FS = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tex;
  uniform int channel; // 0=H,1=S,2=C,3=A

  vec3 hsv2rgb(vec3 c){
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
    vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
    return c.z * mix(vec3(1.0), rgb, c.y);
  }

  void main(){
    vec4 m = texture2D(tex, vUv);
    if(channel==3){
      // Aspect는 Hue로 컬러링
      gl_FragColor = vec4(hsv2rgb(vec3(m.a,1.0,1.0)), 1.0);
    }else{
      float v = (channel==0)? m.r : (channel==1)? m.g : m.b;
      gl_FragColor = vec4(vec3(v), 1.0);
    }
  }
`;

function makeMaskViewMat(chan){
  return new THREE.ShaderMaterial({
    uniforms: {
      tex: { value: terrainMasksRT.texture },
      channel: { value: chan|0 }
    },
    vertexShader: MASK_VIEW_VS,
    fragmentShader: MASK_VIEW_FS,
    toneMapped: false
  });
}

const maskH_Mat = makeMaskViewMat(0);
const maskS_Mat = makeMaskViewMat(1);
const maskC_Mat = makeMaskViewMat(2);
const maskA_Mat = makeMaskViewMat(3);

// 보기 모드 (Shaded = 원래 셰이딩, Masks = 지형 변형 그대로 마스크 렌더)
const baseView = { mode: "Shaded" };

function applyBaseView(){
  if (baseView.mode === "Shaded") {
    ground.material = groundMat;
  } else {
    ground.material = maskOverlayMat;
  }
  ground.material.needsUpdate = true;
}


// 모드(채널)
//const mapMode = { Height:0, Slope:1, Curvature:2, Aspect:3, Composite:4 };

// gui.add({colorMode:"Composite"}, "colorMode", Object.keys(mapMode))
// .name("Mask Mode")
// .onChange(v=>{ maskOverlayMat.uniforms.uMode.value = mapMode[v]; });

// GUI: 모드 + 파라미터
gui.add(baseView, "mode", ["Shaded", "Masks"])
  .name("Base View")
  .onChange(applyBaseView);

// 게인/감마
gui.add(maskOverlayMat.uniforms.gainH,  "value", 0.1, 3.0, 0.01).name("Height Gain");
gui.add(maskOverlayMat.uniforms.gammaH,"value", 0.5, 2.5, 0.01).name("Height Gamma");
gui.add(maskOverlayMat.uniforms.gainS,  "value", 0.1, 4.0, 0.01).name("Slope Gain");
gui.add(maskOverlayMat.uniforms.gainC,  "value", 0.1, 4.0, 0.01).name("Curv Gain");

applyBaseView();

gui.show(); // <- GUI 강제로 표시

// 디버그 미리보기(장면에 평면으로 표시)
// WHERE TO PLACE: 이 블록으로 기존 디버그 평면(_mdebugMesh) 생성부 전체를 교체

// WHERE TO PLACE: 기존 "Overlay 미리보기(카메라에 고정되는 화면 오버레이)" 블록 전체를 이 코드로 교체

// ===== Overlay 미리보기(카메라에 고정되는 화면 오버레이) - Color Mode 지원 =====

// 오버레이 전용 VS (vUv 전달)
const PREVIEW_VS = /* glsl */`
precision highp float;
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// 오버레이 프래그먼트(채널 선택/가중치/컬러링)
const MASKS_PREVIEW_FS = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform sampler2D masksTex; // RGBA: R=Height, G=Slope, B=Curvature, A=Aspect
uniform float uMode;       // 0=Height, 1=Slope, 2=Curvature, 3=Aspect, 4=Composite
uniform float gainH;        // Height 감마/게인 보정 계수(단순 곱)
uniform float gainS;        // Slope 게인
uniform float gainC;        // Curv 게인(0.5를 중심으로 확대/축소)
uniform float gammaH;       // Height 감마 (예: 1.2)

// HSV → RGB 헬퍼 (Aspect 컬러링용)
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  vec3 rgb = clamp(p - 1.0, 0.0, 1.0);
  return c.z * mix(vec3(1.0), rgb, c.y);
}

void main(){
  vec4 m = texture2D(masksTex, vUv);
  float h = m.r;
  float s = m.g;
  float c = m.b;
  float a = m.a;

  // 보정
  h = pow(clamp(h * gainH, 0.0, 1.0), gammaH);
  s = clamp(s * gainS, 0.0, 1.0);
  // 곡률은 0.5가 기준 → 0.5 + (x-0.5)*gain
  float cAdj = clamp(0.5 + (c - 0.5) * gainC, 0.0, 1.0);

vec3 outCol;

if (uMode < 0.5) {           // 0: Height
  outCol = vec3(h);
} else if (uMode < 1.5) {    // 1: Slope
  outCol = vec3(s);
} else if (uMode < 2.5) {    // 2: Curvature
  outCol = vec3(cAdj);
} else if (uMode < 3.5) {    // 3: Aspect
  outCol = hsv2rgb(vec3(a, 1.0, 1.0));
} else {                     // 4: Composite
  outCol = vec3(h, s, cAdj);
}

  gl_FragColor = vec4(outCol, 1.0);
}
`;

// 화면 우하단 프리뷰
const _mdebugGeo = new THREE.PlaneGeometry(8, 4.5);
const _mdebugMat = new THREE.ShaderMaterial({
  uniforms: {
    masksTex: { value: terrainMasksRT.texture },
    uMode:    { value: 4.0 },   // float 로!
    gainH:    { value: 1.0 },
    gainS:    { value: 1.0 },
    gainC:    { value: 1.0 },
    gammaH:   { value: 1.2 },
  },
  vertexShader:   PREVIEW_VS,
  fragmentShader: MASKS_PREVIEW_FS,
  depthTest: false,
  depthWrite: false,
  transparent: false
});

const _mdebugMesh = new THREE.Mesh(_mdebugGeo, _mdebugMat);

// 카메라에 붙여 HUD 처럼 보이게
camera.add(_mdebugMesh);
_mdebugMesh.position.set(6.6, -4.2, -12);
_mdebugMesh.rotation.set(0, 0, 0);
_mdebugMesh.visible = false;
// ===============================================

// WHERE TO PLACE: const gui = new GUI({ title: "Terrain Masks" });  바로 아래 줄

// 1) 파라미터 객체를 '먼저' 정의
const params = {
  // 분석 마스크 파라미터
  slopeScale: terrainMasksMat.uniforms.slopeScale.value, // 기본 120
  curvScale:  terrainMasksMat.uniforms.curvScale.value,  // 기본 20
  seaLevel:   heightMat.uniforms.uSeaLevel.value,        // 기본 0.5
  showMasks:  false,
  reseed:     () => { reseedHeight(); _rebakeTerrainMasks(); },

  // Color Mode/HUD 프리뷰용 (오버레이 셰이더와 연결)
  colorMode: "Composite", // Height | Slope | Curvature | Aspect | Composite
  gainH: 1.0,
  gainS: 1.0,
  gainC: 1.0,
  gammaH: 1.2
};

// === HUD 컨트롤을 즉시 연결 ===
gui.add(params, "colorMode", Object.keys(mapMode))
  .name("Color Mode")
  .onChange(v => {
    _mdebugMat.uniforms.uMode.value = mapMode[v]; // float 값으로 들어감
  });

gui.add(params, "gainH", 0.1, 3.0, 0.01).name("Height Gain").onChange(v=>{
  _mdebugMat.uniforms.gainH.value = v;
});
gui.add(params, "gammaH", 0.5, 2.5, 0.01).name("Height Gamma").onChange(v=>{
  _mdebugMat.uniforms.gammaH.value = v;
});
gui.add(params, "gainS", 0.1, 4.0, 0.01).name("Slope Gain").onChange(v=>{
  _mdebugMat.uniforms.gainS.value = v;
});
gui.add(params, "gainC", 0.1, 4.0, 0.01).name("Curvature Gain").onChange(v=>{
  _mdebugMat.uniforms.gainC.value = v;
});

// HUD 표시 토글 (켜야 보입니다!)
gui.add(params, "showMasks").name("Show Masks (debug)").onChange(v=>{
  _mdebugMesh.visible = v;
});

_mdebugMat.toneMapped = false;
_mdebugMesh.visible = true;   
_mdebugMat.needsUpdate = true;

// 3) ↓↓↓ 아래 컨트롤들은 HUD 오버레이(_mdebugMat/_mdebugMesh)가 생성된 '후에' 실행되어야 함
//    오버레이 블록 아래쪽에 그대로 다시 붙여넣어도 됩니다.
const _attachOverlayControls = ()=>{
  // 안전 체크(오버레이가 아직 없다면 skip)
  if (typeof _mdebugMat === "undefined" || typeof _mdebugMesh === "undefined") return;

  gui.add(params, "colorMode", ["Height","Slope","Curvature","Aspect","Composite"])
    .name("Color Mode")
    .onChange(v=>{
      const map = { Height:0, Slope:1, Curvature:2, Aspect:3, Composite:4 };
      _mdebugMat.uniforms.mode.value = map[v] ?? 4;
    });

  gui.add(params, "gainH", 0.1, 3.0, 0.01).name("Height Gain").onChange(v=>{
    _mdebugMat.uniforms.gainH.value = v;
  });
  gui.add(params, "gammaH", 0.5, 2.5, 0.01).name("Height Gamma").onChange(v=>{
    _mdebugMat.uniforms.gammaH.value = v;
  });

  gui.add(params, "gainS", 0.1, 4.0, 0.01).name("Slope Gain").onChange(v=>{
    _mdebugMat.uniforms.gainS.value = v;
  });

  gui.add(params, "gainC", 0.1, 4.0, 0.01).name("Curvature Gain").onChange(v=>{
    _mdebugMat.uniforms.gainC.value = v;
  });

  gui.add(params, "showMasks").name("Show Masks (debug)").onChange(v=>{
    _mdebugMesh.visible = v;
  });
};

// 오버레이 생성이 끝난 뒤에 한 번 호출하세요 (오버레이 블록 마지막에 호출 권장)
window._attachOverlayControls = _attachOverlayControls;

// 리사이즈 시 디버그 평면 위치/크기 유지(선택)
window.addEventListener("resize", () => {
  // 필요 시 _mdebugMesh 위치/크기 조정 로직 추가
});
// ==============================================

// (참고) 이후 지형 셰이더에서 사용할 준비(예: terrainMasks.frag.glsl의 heightTex 입력)
// groundMat.uniforms.heightTex = { value: heightRT.texture }; // 실제 사용 시 여기에 연결하세요.
// ===== Height RT 초기 굽기(bake) 끝 =====


  // ---------- Resize & Animate ----------
  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    terrainMasksMat.uniforms.texel.value.set(1 / MASKS_RT_W, 1 / MASKS_RT_H);
  });


  // ===== Height RT reseed 함수 시작 =====
function reseedHeight(){
  // 시드 변경 → 다시 굽기
  heightMat.uniforms.uSeed.value = Math.random() * 1000.0; // 여기서 한 줄만 바꾸면 됨 (시드 정책)
  // 필요 시 해수면/해상도 등도 동적으로 조절 가능:
  // heightMat.uniforms.uSeaLevel.value = 0.48;

  renderer.setRenderTarget(heightRT);
  renderer.render(fsScene, fsCam);
  renderer.setRenderTarget(null);

  // (참고) RT가 갱신되었으므로, 이 텍스처를 참조하는 머티리얼에서
  // .needsUpdate = true 가 필요한 경우 설정하세요.
  // if (groundMat.uniforms.heightTex) groundMat.uniforms.heightTex.value = heightRT.texture;
}
// ===== Height RT reseed 함수 끝 =====
// WHERE TO PLACE: 바로 아래 줄 ⬇⬇⬇
// // ===== Height RT reseed 함수 끝 =====

// ===== Terrain Masks RT 재굽기(rebake) 연동 시작 =====
// reseedHeight 이후 Height가 바뀌면 마스크도 즉시 갱신
const _rebakeTerrainMasks = ()=>{
  renderer.setRenderTarget(terrainMasksRT);
  renderer.render(masksScene, masksCam);
  renderer.setRenderTarget(null);
};

// reseedHeight 내부 끝부분에 한 줄 추가가 어렵다면, 다음과 같이 hook:
const _oldReseed = reseedHeight;
reseedHeight = function(){
  _oldReseed();
  _rebakeTerrainMasks();
};
// ===== Terrain Masks RT 재굽기(rebake) 연동 끝 =====


  function animate(){
    controls.update();
    waterMat.uniforms.uTime.value = performance.now() / 1000.0;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
}

boot().catch(err => console.error(err));
