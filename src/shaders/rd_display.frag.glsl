
precision highp float;

uniform sampler2D uState;
uniform vec2  uViewport;       // (width, height) in pixels
uniform float uTiles;          // 1=원본, 2~4 타일 미리보기
uniform float uAccentRatio;    // 0..1  보색 비율
uniform float uPointRadiusPx;  // 점 반경(화소)
uniform vec2  uStateSize;      // (W, H) of state texture (e.g., 512,512)

in vec2 vUv;
out vec4 fragColor;

vec2 R(vec2 uv){ return texture(uState, fract(uv)).rg; }

void main(){
  // 타일 미리보기
  vec2 tuv = fract(vUv * uTiles);

  // 상태값 샘플
  vec2 st = R(tuv);
  float U = st.r;
  float V = st.g;

  // ------------------------------
  // 1) 컬러 매핑 (기본 바탕)
  // U 높을수록 밝게, V 는 보색 톤 (스폿 강조용)
  vec3 baseA = vec3(0.06, 0.07, 0.09);      // 남색/어두운 바탕
  vec3 baseB = vec3(0.95, 0.94, 0.92);      // 밝은 크림
  vec3 colU  = mix(baseA, baseB, smoothstep(0.2, 0.8, U));

  // V 강조 색(와인/마젠타 쪽)
  vec3 accent1 = vec3(0.72, 0.16, 0.28); // 와인
  vec3 accent2 = vec3(0.98, 0.46, 0.36); // 샐몬/분홍
  vec3 colV = mix(accent1, accent2, clamp((V-0.2)/0.6, 0.0, 1.0));

  vec3 baseColor = mix(colU, colV, uAccentRatio * smoothstep(0.25, 0.9, V));

  // ------------------------------
  // 2) 점형 렌더(픽셀 반경 기반)
  // 화면상 한 texel 이 차지하는 픽셀 크기(가로 기준) 추정:
  //   pixelsPerTexelX = viewport.x / (stateWidth * uTiles)
  float pixelsPerTexelX = uViewport.x / (uStateSize.x * uTiles);
  float radiusTexels = uPointRadiusPx / max(pixelsPerTexelX, 1.0); // px → texel

  // texel 중심 좌표 계산
  vec2 grid   = tuv * uStateSize;
  vec2 center = (floor(grid) + 0.5) / uStateSize;

  // texel 공간에서의 거리 (isotropic)
  float distTexel = length((tuv - center) * uStateSize);

  // V 가 높은 곳만 "점" 렌더(핵처럼): 문턱 + 원 마스크
  float spot = smoothstep(0.35, 0.55, V);  // V가 일정 이상일 때만
  float circle = 1.0 - smoothstep(radiusTexels-0.8, radiusTexels+0.2, distTexel);

  float mask = spot * circle;

  vec3 color = mix(baseColor, colV, mask);

  // 콘트라스트 약간
  color = pow(color, vec3(0.95));

  fragColor = vec4(color, 1.0);
}
