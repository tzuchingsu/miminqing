precision highp float;

/*
  RGBA 동시 출력 (Height/Slope/Curvature/Aspect)
*/

uniform sampler2D heightTex; // R 채널 사용
uniform vec2 texel;          // (1.0/width, 1.0/height)
uniform float slopeScale;    // 기본 120.0
uniform float curvScale;     // 기본 20.0

const float PI = 3.14159265358979323846;

void main(){

  vec2 uv = gl_FragCoord.xy * texel;

  float hc = texture2D(heightTex, uv).r;
  float hl = texture2D(heightTex, uv - vec2(texel.x, 0.0)).r;
  float hr = texture2D(heightTex, uv + vec2(texel.x, 0.0)).r;
  float hd = texture2D(heightTex, uv - vec2(0.0, texel.y)).r; // y-
  float hu = texture2D(heightTex, uv + vec2(0.0, texel.y)).r; // y+

  float dhdx = (hr - hl) * 0.5;
float dhdy = (hu - hd) * 0.5;

  float slope = clamp(length(vec2(dhdx, dhdy)) * slopeScale, 0.0, 1.0);

  float lap = (hl + hr + hu + hd - 4.0 * hc);
  float curvature = clamp(0.5 + lap * curvScale, 0.0, 1.0);

  float aspect = (atan(-dhdy, -dhdx) + PI) / (2.0 * PI);

  gl_FragColor = vec4(hc, slope, curvature, aspect);
}
