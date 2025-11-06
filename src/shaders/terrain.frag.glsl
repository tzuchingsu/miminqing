precision mediump float;

uniform float uTime;

varying float vHeight;
varying float vSlope;

void main(){
// 높이 정규화(지형 범위에 맞게 조절: 예 -20~+20)
float t = clamp((vHeight + 20.0) / 40.0, 0.0, 1.0);

vec3 lowColor  = vec3(0.20, 0.45, 0.90);
vec3 midColor  = vec3(0.25, 0.80, 0.35);
vec3 highColor = vec3(1.00, 0.05, 0.00);

float kLowMid  = smoothstep(0.20, 0.40, t);
float kMidHigh = smoothstep(0.65, 0.85, t);
vec3 colLM = mix(lowColor, midColor, kLowMid);
vec3 col   = mix(colLM,    highColor, kMidHigh);

// 경사면 살짝 어둡게
col *= mix(1.0, 0.85, smoothstep(0.03, 0.20, vSlope));

// 가벼운 깜빡임(선택)
col += 0.05 * sin(uTime * 4.0) * smoothstep(0.45, 1.0, t);

gl_FragColor = vec4(col, 1.0);
}