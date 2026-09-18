/**
 * TEST-ONLY. A 2D context that records every method call and property set, in order, so two draw
 * paths can be compared op-for-op in node (vitest runs under `environment: 'node'`; nothing
 * rasterizes there). The sprite cache's equivalence tests live on this: "the cached path emits the
 * direct path's ops, in the direct path's order" is the whole fidelity argument the pixel gate then
 * confirms in a real Chrome.
 */
export interface RecordedOp {
  name: string;
  args: unknown[];
}

export function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: RecordedOp[] } {
  const ops: RecordedOp[] = [];
  const grad = {
    addColorStop: (s: number, c: string) => {
      ops.push({ name: 'addColorStop', args: [s, c] });
    },
  };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      const name = String(prop);
      if (name === 'canvas') return { width: 1920, height: 1080 };
      if (name === 'measureText') return () => ({ width: 0 });
      if (name.startsWith('create') && name.endsWith('Gradient')) {
        return (...args: unknown[]) => {
          ops.push({ name, args });
          return grad;
        };
      }
      return (...args: unknown[]) => {
        ops.push({ name, args });
      };
    },
    set(_t, prop, value) {
      ops.push({ name: `set:${String(prop)}`, args: [value] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

/** One line per op, numbers to 4 dp — stable across runs, readable in a diff. */
export function fmtOps(ops: RecordedOp[]): string[] {
  return ops.map(
    (o) => `${o.name}(${o.args.map((a) => (typeof a === 'number' ? a.toFixed(4) : String(a))).join(',')})`,
  );
}
