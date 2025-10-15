
precision highp float;

uniform float uThreshold; // 0.99 附近：值越大 → 點越稀疏
uniform float uTime;

in vec2 vUv;
out vec4 fragColor;

// hash-based pseudo-random
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main(){
  vec2 uv = fract(vUv); // seamless
  float r = hash12(uv + fract(uTime*0.001));
  // 大部分 U=1, V=0；少數地方 V=1 作為 시드
  float U = 1.0;
  float V = step(uThreshold, r); // r >= threshold -> 1
  fragColor = vec4(U, V, 0.0, 1.0);
}
