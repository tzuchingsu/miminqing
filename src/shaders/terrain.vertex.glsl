precision highp float;
precision highp int;

uniform float uScale, uAmp, uGrow;
uniform int   uOctaves;
uniform float uLacunarity, uGain;
uniform float uAScale, uATerraceSteps;
uniform float uBScale, uBThreshLo, uBThreshHi;
uniform float uRimGain;
uniform float uRiverWidth, uRiverFeather, uRiverBase;

varying vec3  vWorldPos;
varying float vH;
varying float vRiverMask;
varying vec2 vUv;

vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v){
  const float C = 0.211324865405187;
  const float F = 0.366025403784439;
  float s = (v.x+v.y)*F;
  vec2 i = floor(v + s);
  float t = (i.x + i.y) * C;
  vec2 X0 = i - t;
  vec2 x0 = v - X0;

  vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
  vec2 x1 = x0 - i1 + C;
  vec2 x2 = x0 - 1.0 + 2.0*C;

  i = mod289(i);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0) )
                  + i.x + vec3(0.0, i1.x, 1.0) );

  vec3 x = fract(p * (1.0/41.0)) * 2.0 - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;

  vec2 g0 = vec2(a0.x, h.x);
  vec2 g1 = vec2(a0.y, h.y);
  vec2 g2 = vec2(a0.z, h.z);

  vec3 w = max(0.5 - vec3(dot(x0,x0), dot(x1,x1), dot(x2,x2)), 0.0);
  vec3 w4 = w*w*w*w;

  float n0 = dot(g0, x0);
  float n1 = dot(g1, x1);
  float n2 = dot(g2, x2);

  return 40.0 * dot(w4, vec3(n0,n1,n2));
}

float fbm_simple(vec2 p, int oct, float lac, float gain){
  float n = 0.0, a = 0.5, f = 1.0;
  for(int o=0;o<12;o++){
    if(o>=oct) break;
    n += snoise(p*f) * a;
    f *= lac; a *= gain;
  }
  return clamp(n, -1.0, 1.0);
}
float terrace(float h, float steps){
  float s = max(2.0, steps);
  float u = 0.5*h + 0.5;
  float t = floor(u*s)/s;
  return t*2.0 - 1.0;
}
float genA(vec2 p){
  float h = fbm_simple(p, uOctaves, uLacunarity, uGain);
  return terrace(h, uATerraceSteps);
}

float genB(vec2 p){
  float n = snoise(p);
  float m = 0.5*n + 0.5;
  return smoothstep(uBThreshLo, uBThreshHi, m);
}

float riverMask(vec2 pNoise){
  float a = abs(pNoise.x);
  float edge = 1.0 - smoothstep(uRiverWidth, uRiverWidth + uRiverFeather, a);
  return pow(edge, 2.0);
}

void main(){

    vUv = uv;
  vec3 pos = position;
  vec2 pWorld = pos.xz;
  vec2 pNoise = pWorld * uScale;

  float A = genA(pNoise * uAScale);
  float B = genB(pNoise * uBScale);
  float h = A + uRimGain * B;

  float mRiver = riverMask(pNoise);
  h = mix(h, uRiverBase, mRiver);

  pos.y += h * uAmp * uGrow;

  vH = h;
  vRiverMask = mRiver;
  vec4 wp = modelMatrix * vec4(pos,1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
