// vite-plugin-glsl imports resolve to the shader source as a string.
declare module '*.glsl' {
  const source: string;
  export default source;
}
declare module '*.vert.glsl' {
  const source: string;
  export default source;
}
declare module '*.frag.glsl' {
  const source: string;
  export default source;
}
