precision highp float;
precision highp int;

uniform vec3  uLightDir;
uniform float uScale, uAmp, uGrow;
uniform int   uOctaves;
uniform float uLacunarity, uGain;
uniform float uAScale, uATerraceSteps;
uniform float uBScale, uBThreshLo, uBThreshHi;
uniform float uRimGain;
uniform float uRiverWidth, uRiverFeather, uRiverBase;

uniform vec3  uColGrass, uColForest, uColRock, uColRiver;
uniform float uFogDensity;

varying vec3  vWorldPos;
varying float vH;
varying float vRiverMask;

vec3 mod289_vec3(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec2 mod289_vec2(vec2 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec3 permute_vec3(vec3 x){ return mod289_vec3(((x*34.0)+1.0)*x); }
float snoise2(vec2 v){
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

  i = mod289_vec2(i);
  vec3 p = permute_vec3( permute_vec3( i.y + vec3(0.0, i1.y, 1.0))
                       + i.x + vec3(0.0, i1.x, 1.0));
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
float fbm2(vec2 p, int oct, float lac, float gain){
  float n=0.0,a=0.5,f=1.0;
  for(int o=0;o<12;o++){ if(o>=oct) break;
    n += snoise2(p*f)*a; f*=lac; a*=gain;
  }
  return clamp(n,-1.0,1.0);
}
float terrace2(float h, float steps){
  float s=max(2.0,steps); float u=0.5*h+0.5; float t=floor(u*s)/s; return t*2.0-1.0;
}
float genA2(vec2 p){ return terrace2(fbm2(p, uOctaves, uLacunarity, uGain), uATerraceSteps); }
float genB2(vec2 p){ float n=snoise2(p); float m=0.5*n+0.5; return smoothstep(uBThreshLo,uBThreshHi,m); }
float riverMask2(vec2 pNoise){
  float a = abs(pNoise.x);
  float edge = 1.0 - smoothstep(uRiverWidth, uRiverWidth + uRiverFeather, a);
  return pow(edge, 2.0);
}

vec3 calcNormal(vec2 wxz){
  float eps = 0.35;
  vec2 p0 = wxz * uScale;

  float A0 = genA2(p0 * uAScale);
  float B0 = genB2(p0 * uBScale);
  float h0 = mix(A0 + uRimGain*B0, uRiverBase, riverMask2(p0));
  float H0 = h0 * uAmp * uGrow;

  vec2 px = (wxz + vec2(eps,0.0)) * uScale;
  float Ax = genA2(px * uAScale);
  float Bx = genB2(px * uBScale);
  float hx = mix(Ax + uRimGain*Bx, uRiverBase, riverMask2(px));
  float HX = hx * uAmp * uGrow;

  vec2 pz = (wxz + vec2(0.0,eps)) * uScale;
  float Az = genA2(pz * uAScale);
  float Bz = genB2(pz * uBScale);
  float hz = mix(Az + uRimGain*Bz, uRiverBase, riverMask2(pz));
  float HZ = hz * uAmp * uGrow;

  vec3 dX = vec3(eps, HX - H0, 0.0);
  vec3 dZ = vec3(0.0, HZ - H0, eps);
  return normalize(cross(dZ, dX));
}

void main(){
  float h01 = clamp(0.5*(vH + 1.0), 0.0, 1.0);
  float forestMask = genB2(vWorldPos.xz * uScale * uBScale);
  vec3 groundCol = mix(uColGrass, uColRock, smoothstep(0.45, 0.75, h01));
  groundCol = mix(groundCol, uColForest, forestMask * 0.6);

  vec3 baseCol = mix(groundCol, uColRiver, vRiverMask);

  vec3 N = calcNormal(vWorldPos.xz);
  float diff = clamp(dot(N, normalize(uLightDir)), 0.0, 1.0);
  float ambient = 0.70;
  vec3 col = baseCol * (ambient + (1.0 - ambient) * diff);

  float dist = length(vWorldPos.xz);
  float fogFactor = 1.0 - exp(-uFogDensity * dist * dist);
  col = mix(col, vec3(1.0), fogFactor);

  gl_FragColor = vec4(col, 1.0);
}
