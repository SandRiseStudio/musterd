// musterd hero — particle field vertex shader.
// Cheap trig-based drift (no expensive noise) so it stays smooth on mobile.

uniform float uTime;
uniform float uProgress;   // 0 → 1 entrance, driven by anime.js via the three adapter
uniform float uSize;       // base point size, also animated on entrance
uniform float uPixelRatio;
uniform vec2  uPointer;     // -1 → 1, parallax

attribute vec3 aSeed;       // per-point randomness
attribute float aScale;     // per-point size multiplier

varying float vAlpha;
varying float vGlow;

void main() {
  vec3 pos = position;

  // Lazy orbital drift — three offset sines per axis keyed off the seed.
  float t = uTime * 0.12;
  pos.x += sin(t + aSeed.x * 6.2831) * (0.35 + aSeed.z * 0.4);
  pos.y += cos(t * 1.1 + aSeed.y * 6.2831) * (0.30 + aSeed.x * 0.4);
  pos.z += sin(t * 0.8 + aSeed.z * 6.2831) * (0.45 + aSeed.y * 0.4);

  // Entrance: points converge from a deeper, scattered shell toward their resting place.
  float ease = uProgress * uProgress * (3.0 - 2.0 * uProgress); // smoothstep
  pos *= mix(1.55, 1.0, ease);
  pos.z -= (1.0 - ease) * 3.0;

  // Pointer parallax — nearer points (larger aScale) move a touch more.
  pos.xy += uPointer * (0.25 + aScale * 0.35);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  // Perspective size attenuation.
  gl_PointSize = uSize * aScale * uPixelRatio * (12.0 / -mv.z);

  // Fade out with depth, fade in with the entrance; a brighter core for the closest points.
  float depth = clamp((-mv.z - 2.0) / 10.0, 0.0, 1.0);
  vAlpha = ease * mix(0.9, 0.12, depth);
  vGlow = smoothstep(0.6, 1.0, aScale);
}
