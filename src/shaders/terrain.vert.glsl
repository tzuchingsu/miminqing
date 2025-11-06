precision mediump float;

uniform float uTime;

// CPU에서 이미 변형된 지오메트리를 받음
// 따라서 여기서는 높이/경사만 읽어서 넘기면 됨
varying float vHeight;
varying float vSlope;

void main(){
// CPU 변형 결과: position.y가 곧 지형 높이
vHeight = position.y;

// CPU가 계산한 normal을 이용해 경사 근사
// (수직=1, 수평=0 → 경사 = 1 - ny)
float ny = clamp(normal.y, 0.0, 1.0);
vSlope = 1.0 - ny;

gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}