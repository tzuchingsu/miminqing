
precision highp float;

uniform sampler2D uState;   // RG=(U,V)
uniform float uFeed;        // f → 모양(spot/stripe)
uniform float uKill;        // k → 모양(spot/stripe)
uniform float uDu;          // Du → 질감(미세/굵음)
uniform float uDv;          // Dv → 질감(미세/굵음)
uniform float uDt;          // 시간 스텝(속도)
uniform float uSubsteps;    // 서브스텝(안정)
uniform vec2  uTexel;       // 1.0 / stateRT 分辨率（dx,dy）

in vec2 vUv;
out vec4 fragColor;

vec2 R(vec2 uv){ return texture(uState, fract(uv)).rg; } // seamless

// 3x3 Laplacian (합계≈0). 선명도/안정 균형 커널
void lap(in vec2 uv, out float Lu, out float Lv){
  vec2 c   = R(uv);
  vec2 dx  = vec2(uTexel.x, 0.0);
  vec2 dy  = vec2(0.0, uTexel.y);

  vec2 u00 = R(uv - dx - dy);
  vec2 u10 = R(uv      - dy);
  vec2 u20 = R(uv + dx - dy);

  vec2 u01 = R(uv - dx);
  vec2 u21 = R(uv + dx);

  vec2 u02 = R(uv - dx + dy);
  vec2 u12 = R(uv      + dy);
  vec2 u22 = R(uv + dx + dy);

  vec2 sum =
      0.05 * (u00 + u20 + u02 + u22) +
      0.20 * (u10 + u01 + u21 + u12) +
     -1.00 *  c;

  Lu = sum.r;
  Lv = sum.g;
}

void main(){
  int steps = max(1, int(floor(uSubsteps)));
  float dt  = uDt / float(steps);

  float U = R(vUv).r;
  float V = R(vUv).g;

  for(int i=0;i<256;i++){
    if(i>=steps) break;

    float Lu, Lv;
    lap(vUv, Lu, Lv);

    float uvv = U * V * V;
    float dU  = uDu * Lu - uvv + uFeed * (1.0 - U);
    float dV  = uDv * Lv + uvv - (uFeed + uKill) * V;

    U += dU * dt;
    V += dV * dt;

    U = clamp(U, 0.0, 1.0);
    V = clamp(V, 0.0, 1.0);
  }

  fragColor = vec4(U, V, 0.0, 1.0);
}

/* 조정 가이드
[모양 spot/stripe]
- spot:   f↑, k↑   (예: f=0.030~0.045, k=0.055~0.070)
- stripe: f↓, k↓   (예: f=0.018~0.028, k=0.045~0.060)

[질감 미세↔굵음]
- Du,Dv 작게 → 미세   / 크게 → 굵음
  (권장 Du=0.10~0.24, Dv=0.04~0.12, 보통 Du≈2×Dv)

[속도 느림↔빠름]
- uDt↑ → 빠름(불안정 위험) → uSubsteps↑ 권장 (6~24)
*/
