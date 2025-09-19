uniform vec3 uCol;
varying vec2 vUv;
void main(){
  float wave = 0.5 + 0.5*sin(vUv.x*20.0 + vUv.y*15.0);
  vec3 col = uCol * (0.9 + 0.1*wave);
  gl_FragColor = vec4(col, 0.85);
}
