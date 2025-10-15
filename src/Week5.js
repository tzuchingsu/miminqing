import * as THREE from "three";
import GUI from "lil-gui";

// HUD
const hud = document.getElementById("hud");
if (hud) hud.textContent = "R: reseed (시드 다시 만들기)";

// WebGL2 檢查
const isWebGL2 = (() => {
  const c = document.createElement("canvas");
  return !!c.getContext("webgl2");
})();
if (!isWebGL2) {
  console.error("이 데모는 WebGL2가 필요합니다. (크롬/파폭 최신, 하드웨어 가속 ON)");
}

// Renderer
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: true,
  preserveDrawingBuffer: true,  // ← 캔버스 내용을 toDataURL로 읽기 위함
  premultipliedAlpha: false,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

renderer.setClearColor(0x111111, 1);
document.body.appendChild(renderer.domElement);

// 擴充
const gl = renderer.getContext();
if (!gl.getExtension("EXT_color_buffer_float")) {
  console.warn("EXT_color_buffer_float 확장이 필요합니다.");
}

// 讀檔
async function loadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  return res.text();
}
const vertSrc    = await loadText("./src/shaders/screen.vert.glsl");
const initSrc    = await loadText("./src/shaders/rd_init.frag.glsl");
const updateSrc  = await loadText("./src/shaders/rd_update.frag.glsl");
const displaySrc = await loadText("./src/shaders/rd_display.frag.glsl");

// 相機/場景/四邊形
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const sceneInit = new THREE.Scene();
const sceneUpdate = new THREE.Scene();
const sceneDisplay = new THREE.Scene();

const quad = new THREE.BufferGeometry();
quad.setAttribute("position", new THREE.BufferAttribute(
  new Float32Array([-1,-1,0,  1,-1,0,  -1,1,0,  1,1,0]), 3
));
quad.setIndex([0,1,2, 2,1,3]);

// 狀態 RT (ping-pong)
const SIZE = 512;
const makeRT = () => {
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.wrapT = THREE.RepeatWrapping;
  return rt;
};
const rtA = makeRT();
const rtB = makeRT();
let readRT = rtA;
let writeRT = rtB;

// --- 初始化 pass
const initMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: vertSrc,
  fragmentShader: initSrc,
  uniforms: {
    uThreshold: { value: 0.99613 },
    uTime: { value: 0 },
  },
  depthTest: false,
  depthWrite: false,
});
const initMesh = new THREE.Mesh(quad, initMat);
sceneInit.add(initMesh);

function reseed() {
  initMat.uniforms.uTime.value = performance.now();
  renderer.setRenderTarget(readRT);
  renderer.render(sceneInit, camera);
  renderer.setRenderTarget(null);
}
reseed(); // 初次種子

// --- 更新 pass (Gray–Scott)
const updateMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: vertSrc,
  fragmentShader: updateSrc,
  uniforms: {
    uState:     { value: readRT.texture },
    uFeed:      { value: 0.037 }, // spot 경향
    uKill:      { value: 0.065 }, //
    uDu:        { value: 0.18  }, // 질감: 보통~굵음
    uDv:        { value: 0.09  },
    uDt:        { value: 1.0   }, // 빠름
    uSubsteps:  { value: 12.0  },
    uTexel:     { value: new THREE.Vector2(1/SIZE, 1/SIZE) },
  },
  depthTest: false,
  depthWrite: false,
  blending: THREE.NoBlending,
});
const updateMesh = new THREE.Mesh(quad, updateMat);
sceneUpdate.add(updateMesh);

// --- 顯示 pass
const viewport = new THREE.Vector2(window.innerWidth, window.innerHeight);
const displayMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: vertSrc,
  fragmentShader: displaySrc,
  uniforms: {
    uState:        { value: readRT.texture },
    uTiles:        { value: 1.0 },
    uViewport:     { value: viewport },
    uAccentRatio:  { value: 0.40 }, // 와인색 비율
    uPointRadiusPx:{ value: 6.0 },  // 점 반径(px)
    uStateSize:    { value: new THREE.Vector2(SIZE, SIZE) },
  },
  depthTest: false,
  depthWrite: false,
});
const displayMesh = new THREE.Mesh(quad, displayMat);
sceneDisplay.add(displayMesh);

// --- GUI（Pattern / Texture scale / Tempo）
const params = {
  // 個別
  feed: 0.037,
  kill: 0.065,
  Du:   0.18,
  Dv:   0.09,
  uDt:  1.0,
  SUBSTEPS: 12,

  // 連動
  textureScale: 0.55, // 0=細 1=粗 → Du,Dv 同時
  tempo:        0.70, // 0=慢 1=快 → uDt,SUBSTEPS 同時

  // 顯示
  tiles: 1.0,
  accent: 0.4,
  pointRadius: 6.0,

  // 預設
  Pattern_spot:   () => applyPreset("spot"),
  Pattern_stripe: () => applyPreset("stripe"),
  Pattern_hybrid: () => applyPreset("hybrid"),
};

function mapTextureScale(t){
  const Du = THREE.MathUtils.lerp(0.10, 0.24, t);
  const Dv = THREE.MathUtils.lerp(0.04, 0.12, t);
  return { Du, Dv };
}
function mapTempo(t){
  const uDt = THREE.MathUtils.lerp(0.30, 1.20, t);
  const sub = Math.round(THREE.MathUtils.lerp(6, 24, t));
  return { uDt, SUBSTEPS: sub };
}
function syncUpdateUniforms(){
  updateMat.uniforms.uFeed.value     = params.feed;
  updateMat.uniforms.uKill.value     = params.kill;
  updateMat.uniforms.uDu.value       = params.Du;
  updateMat.uniforms.uDv.value       = params.Dv;
  updateMat.uniforms.uDt.value       = params.uDt;
  updateMat.uniforms.uSubsteps.value = params.SUBSTEPS;
}
function syncDisplayUniforms(){
  displayMat.uniforms.uTiles.value        = params.tiles;
  displayMat.uniforms.uAccentRatio.value  = params.accent;
  displayMat.uniforms.uPointRadiusPx.value= params.pointRadius;
}

function applyPreset(name){
  if(name==="spot"){
    params.feed = 0.037; params.kill = 0.065;
    params.textureScale = 0.55; params.tempo = 0.75;
  }else if(name==="stripe"){
    params.feed = 0.024; params.kill = 0.055;
    params.textureScale = 0.60; params.tempo = 0.60;
  }else{ // hybrid
    params.feed = 0.030; params.kill = 0.058;
    params.textureScale = 0.58; params.tempo = 0.68;
  }
  const td = mapTextureScale(params.textureScale);
  params.Du = td.Du; params.Dv = td.Dv;
  const tp = mapTempo(params.tempo);
  params.uDt = tp.uDt; params.SUBSTEPS = tp.SUBSTEPS;

  gui.controllersRecursive().forEach(c=>c.updateDisplay?.());
  syncUpdateUniforms();
}

const gui = new GUI();
const gShape = gui.addFolder("Pattern (모양)");
gShape.add(params, "feed", 0.016, 0.06, 0.0001).name("feed f · 모양").onChange(v=>{ params.feed=v; syncUpdateUniforms(); });
gShape.add(params, "kill", 0.035, 0.08, 0.0001).name("kill k · 모양").onChange(v=>{ params.kill=v; syncUpdateUniforms(); });
gShape.add(params, "Pattern_spot").name("Preset: spot");
gShape.add(params, "Pattern_stripe").name("Preset: stripe");
gShape.add(params, "Pattern_hybrid").name("Preset: hybrid");
gShape.open();

const gTex = gui.addFolder("Texture scale (질감)");
gTex.add(params, "textureScale", 0, 1, 0.001).name("미세 ↔ 굵음 · 질감").onChange(t=>{
  const {Du, Dv} = mapTextureScale(t);
  params.Du = Du; params.Dv = Dv;
  gui.controllersRecursive().forEach(c=>c.updateDisplay?.());
  syncUpdateUniforms();
});
gTex.add(params, "Du", 0.06, 0.30, 0.0001).name("Du · 질감").onChange(v=>{ params.Du=v; syncUpdateUniforms(); });
gTex.add(params, "Dv", 0.02, 0.18, 0.0001).name("Dv · 질감").onChange(v=>{ params.Dv=v; syncUpdateUniforms(); });
gTex.open();

const gTime = gui.addFolder("Tempo (속도)");
gTime.add(params, "tempo", 0, 1, 0.001).name("느림 ↔ 빠름 · 속도").onChange(t=>{
  const {uDt, SUBSTEPS} = mapTempo(t);
  params.uDt = uDt; params.SUBSTEPS = SUBSTEPS;
  gui.controllersRecursive().forEach(c=>c.updateDisplay?.());
  syncUpdateUniforms();
});
gTime.add(params, "uDt", 0.1, 1.5, 0.001).name("uDt · 속도").onChange(v=>{ params.uDt=v; syncUpdateUniforms(); });
gTime.add(params, "SUBSTEPS", 1, 32, 1).name("Substeps · 안정").onChange(v=>{ params.SUBSTEPS=v; syncUpdateUniforms(); });
gTime.open();

const gView = gui.addFolder("Display (표시)");
gView.add(params, "tiles", 1, 4, 1).name("Tiles · 미리보기").onChange(()=>syncDisplayUniforms());
gView.add(params, "accent", 0, 1, 0.01).name("Accent Ratio").onChange(()=>syncDisplayUniforms());
gView.add(params, "pointRadius", 2, 12, 0.1).name("Point Radius(px)").onChange(()=>syncDisplayUniforms());
gView.open();

// 初次套入 spot
applyPreset("spot");
syncDisplayUniforms();

// 視窗縮放
function onResize(){
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewport.set(window.innerWidth, window.innerHeight);
  displayMat.uniforms.uViewport.value.copy(viewport);
  updateMat.uniforms.uTexel.value.set(1/SIZE, 1/SIZE);
}
window.addEventListener("resize", onResize);

// R reseed
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r") reseed();
});

// 單步更新 (read -> write)
function stepOnce(){
  updateMat.uniforms.uState.value = readRT.texture;
  displayMat.uniforms.uState.value = readRT.texture;

  // update: read→write
  renderer.setRenderTarget(writeRT);
  renderer.render(sceneUpdate, camera);
  renderer.setRenderTarget(null);

  // swap
  const tmp = readRT; readRT = writeRT; writeRT = tmp;
}

// 迴圈
renderer.setAnimationLoop(() => {
  stepOnce();
  displayMat.uniforms.uState.value = readRT.texture; // 顯示用
  renderer.render(sceneDisplay, camera);
});

// ▼ PNG 저장 버튼 UI
const btn = document.createElement("button");
btn.textContent = "💾 Save PNG";
btn.style.position = "fixed";
btn.style.top = "10px";
btn.style.right = "10px";
btn.style.zIndex = "1001";
btn.style.padding = "6px 10px";
btn.style.fontSize = "14px";
btn.style.border = "none";
btn.style.borderRadius = "4px";
btn.style.background = "#222";
btn.style.color = "#fff";
btn.style.cursor = "pointer";
btn.style.opacity = "0.8";
btn.onmouseenter = () => (btn.style.opacity = "1");
btn.onmouseleave = () => (btn.style.opacity = "0.8");
document.body.appendChild(btn);

// ▼ 기존 savePNG() 함수를 이걸로 교체하세요.
function savePNG(targetSize = 1024, filename = "reaction_diffusion_1024.png") {
  // 0) 안전: 최신 프레임으로 한 번 더 그려둠 (원래 해상도)
  renderer.setRenderTarget(null);
  renderer.render(sceneDisplay, camera);

  // 1) 현재 상태 백업
  const oldPR = renderer.getPixelRatio();
  const oldW  = renderer.domElement.width;   // 드로잉 버퍼 폭(px)
  const oldH  = renderer.domElement.height;  // 드로잉 버퍼 높이(px)

  // 2) 정사각 해상도로 전환 (CSS 크기는 유지)
  renderer.setPixelRatio(1);
  renderer.setSize(targetSize, targetSize, false);

  // 3) uViewport 등 화면 크기 의존 유니폼 갱신
  viewport.set(targetSize, targetSize);
  displayMat.uniforms.uViewport.value.copy(viewport);

  // 4) 저장 프레임 렌더(필수) — 버퍼가 초기화되므로 다시 그려줘야 함
  //    패턴을 더 진행시키고 싶으면 stepOnce()를 몇 번 호출한 뒤 렌더하세요.
  // for (let i = 0; i < 0; i++) stepOnce(); // 원하면 증가
  renderer.setRenderTarget(null);
  renderer.render(sceneDisplay, camera);

  // 5) PNG 추출 & 다운로드
  const dataURL = renderer.domElement.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataURL;
  a.download = filename;
  a.click();

  // 6) 원래 상태 복원
  renderer.setPixelRatio(oldPR);
  renderer.setSize(oldW, oldH, false);
  viewport.set(oldW, oldH);
  displayMat.uniforms.uViewport.value.copy(viewport);

  // (선택) 복원 직후 한 번 더 렌더하여 화면을 즉시 업데이트
  renderer.setRenderTarget(null);
  renderer.render(sceneDisplay, camera);
}

// ▼ 버튼 클릭 시 저장 실행
btn.addEventListener("click", () =>
  savePNG(1024, "reaction_diffusion_1024.png")
);

