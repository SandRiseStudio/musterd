// musterd hero — particle field fragment shader.
// Soft round sprite, mustard body with a warm-white core, additive-blended for glow.

precision mediump float;

uniform vec3 uColor;      // mustard
uniform vec3 uColorCore;  // warm white

varying float vAlpha;
varying float vGlow;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  // Soft disc with a hot center.
  float disc = smoothstep(0.5, 0.0, d);
  float core = smoothstep(0.18, 0.0, d);

  vec3 color = mix(uColor, uColorCore, core * (0.5 + 0.5 * vGlow));
  float alpha = disc * vAlpha;

  gl_FragColor = vec4(color, alpha);
}
