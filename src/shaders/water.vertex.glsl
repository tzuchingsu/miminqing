uniform float uTime, uWaveAmp, uWaveFreq, uWaveSpeed;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec3 pos = position;
  pos.y += sin(pos.x * uWaveFreq + uTime * uWaveSpeed) * uWaveAmp;
  pos.y += cos(pos.z * uWaveFreq * 0.7 + uTime * uWaveSpeed * 1.1) * uWaveAmp * 0.6;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
