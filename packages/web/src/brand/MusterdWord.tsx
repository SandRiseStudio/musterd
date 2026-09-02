import { CHIP_BG, CHIP_FG, CHIP_M_PATH, CHIP_NOTCH, CHIP_RADIUS } from './chipMark';

type MusterdChipProps = {
  size?: number;
  className?: string;
};

/** Compact brand chip — mustard block, reversed m, cursor notch (ADR 154). */
export function MusterdChip({ size = 16, className }: MusterdChipProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      aria-hidden
      role="img"
    >
      <rect width="32" height="32" rx={CHIP_RADIUS} fill={CHIP_BG} />
      <path fill={CHIP_FG} d={CHIP_M_PATH} />
      <rect {...CHIP_NOTCH} fill={CHIP_FG} />
    </svg>
  );
}

type MusterdWordProps = {
  className?: string;
  chipSize?: number;
};

/** Topbar wordmark lockup: chip + lowercase musterd. */
export function MusterdWord({ className = 'lc__word', chipSize = 16 }: MusterdWordProps) {
  return (
    <span className={className}>
      <MusterdChip size={chipSize} className="brand__chip" />
      musterd
    </span>
  );
}
