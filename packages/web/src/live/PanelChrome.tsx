/**
 * Shared collapse/expand chrome for the three live panels (office · roster · stream).
 *
 * Each panel carries a small **collapse pill** in its header; collapsing shrinks the panel to a slim
 * vertical **rail** (a spine) that the neighbours flow into — the width animates on the canvas grid, so
 * the motion is one smooth, magical slide rather than a hard cut. The rail itself is one big button:
 * click anywhere on it to expand again. `side` orients the chevrons toward where the panel grows/folds
 * ('left' = leftmost office, 'right' = rightmost stream, 'mid' = the roster in between).
 */

type Side = 'left' | 'right' | 'mid';

/** A chevron that points the way the panel will *fold* (used in the header collapse pill). */
function FoldChevron({ side }: { side: Side }) {
  // office folds left, stream folds right, roster folds left (toward the office).
  const right = side === 'right';
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {right ? <path d="M6.5 4 10.5 8l-4 4" /> : <path d="M9.5 4 5.5 8l4 4" />}
      <path d={right ? 'M11.5 4v8' : 'M4.5 4v8'} />
    </svg>
  );
}

/** The header pill that collapses the panel. */
export function CollapseButton({
  side,
  label,
  onClick,
}: {
  side: Side;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="lc-collapse"
      onClick={onClick}
      aria-label={`Collapse ${label}`}
      title={`Collapse ${label}`}
    >
      <FoldChevron side={side} />
    </button>
  );
}

/**
 * The collapsed spine. One tall button: the vertical title reads bottom-to-top, a chevron points the
 * way it will unfold, and an optional `hint` (a live count) rides the base so a folded panel still
 * says something at a glance.
 */
export function PanelRail({
  side,
  label,
  hint,
  onExpand,
}: {
  side: Side;
  label: string;
  hint?: string | undefined;
  onExpand: () => void;
}) {
  // The rail's chevron points *outward* — the direction the panel expands into.
  const grows: Side = side === 'right' ? 'left' : 'right';
  return (
    <button
      type="button"
      className={`lc-rail lc-rail--${side}`}
      onClick={onExpand}
      aria-label={`Expand ${label}`}
      title={`Expand ${label}`}
    >
      <span className="lc-rail__chevron" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          {grows === 'right' ? <path d="M5.5 4 9.5 8l-4 4" /> : <path d="M10.5 4 6.5 8l4 4" />}
        </svg>
      </span>
      <span className="lc-rail__label">{label}</span>
      {hint && <span className="lc-rail__hint">{hint}</span>}
    </button>
  );
}
