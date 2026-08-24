export function classifyCssBundle<Group extends string>(
  file: string,
  bundles: Record<Group, readonly string[]>,
): { base: string; group: Group | undefined } {
  const filename = file.split('/').pop()!;
  for (const group of Object.keys(bundles) as Group[]) {
    const base = bundles[group].find(
      (candidate) => filename === `${candidate}.css` || filename.startsWith(`${candidate}-`),
    );
    if (base && filename.endsWith('.css')) return { base, group };
  }
  return { base: filename.replace(/\.css$/, ''), group: undefined };
}
