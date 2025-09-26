precision highp float;

/*
  Height RT baker
  - R: height [0..1]
  - G/B: 0
  - A: 1
  uniforms:
    uResolution : 렌더타겟 해상도(px) — gl_FragCoord를 0~1 정규화에 사용
    uSeed       : 시드(패턴 바꾸기)
    uSeaLevel   : 해수면 기준(예: 0.50). 해안선 부드럽게(smoothstep) 완화

  알고리즘 개요:
    uv = gl_FragCoord.xy / uResolution;    // 0~1
    h  = fbm( uv * 0.5 + uSeed*0.01 );     // 여기서 한 줄만 바꾸면 됨 (주 파장)
    h  = pow(h, 1.20);                     // 감마 보정 (지형 대비 조절)
    해수면 완화:   h = mix(uSeaLevel, h, smoothstep(uSeaLevel-ε, uSeaLevel+ε, h));
*/

uniform vec2  uResolution;
uniform float uSeed;
uniform float uSeaLevel;

// ------------------------------
// Hash & Value Noise (2D)
// ------------------------------
float hash21(vec2 p){
  // seed를 살짝 섞어 패턴 재현성 유지
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 78.233 + uSeed*0.0001);
  return fract(p.x * p.y * 53758.5453);
}

// Quintic fade (더 부드러운 보간)
vec2 fade(vec2 t){ return t*t*t*(t*(t*6.0 - 15.0) + 10.0); }

float valueNoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);

  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));

  vec2 u = fade(f);
  // bilinear + smooth blending
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 약간의 회전을 주어 방향성 줄이기
mat2 rot2(float a){
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

// ------------------------------
// fBm (Fractal Brownian Motion)
// ------------------------------
float fbm(vec2 p){
  // 기본 파라미터 — 여기서 한 줄만 바꾸면 됨 (octaves / lacunarity / gain)
  const int   OCT  = 6;
  const float LAC  = 2.0;
  const float GAIN = 0.5;

  float amp = 0.5;
  float sum = 0.0;

  // seed에 따른 offset
  p += uSeed * 0.01;

  // 미세한 회전 누적
  mat2 R = rot2(0.5);

  for(int i=0; i<OCT; i++){
    sum += amp * valueNoise(p);
    p = R * p * LAC;
    amp *= GAIN;
  }

  // valueNoise는 [0..1]이므로 sum 범위는 [0..1]보다 약간 넓을 수 있음 → clamp
  return clamp(sum, 0.0, 1.0);
}

void main(){
  // 0~1 정규화 좌표
  vec2 uv = gl_FragCoord.xy / uResolution;

  // 주 파장: uv*0.5   (지형 스케일)
  float h = fbm(uv * 0.5);

  // 감마 보정: 지형 대비/평탄도 조절
  h = pow(h, 1.20);

  // 해안선(해수면) 완화: ε은 연안 폭(softness)
  float eps = 0.02; // 여기서 한 줄만 바꾸면 됨 (연안 부드러움)
  float coast = smoothstep(uSeaLevel - eps, uSeaLevel + eps, h);
  h = mix(uSeaLevel, h, coast);

  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}
