vec2 pN = (vec3(transformed).xz) * uScale;
float A = genA(pN * uAScale);
float B = genB(pN * uBScale);
float h = mix(A + uRimGain*B, uRiverBase, riverMask(pN));
transformed.y += h * uAmp * uGrow;
