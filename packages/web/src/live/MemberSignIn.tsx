// The shared "connect as a real seat" affordance (item 5) — one sign-in, two consumers (/live and
// /board), no duplication. Presentational only: state lives in the route (live.tsx `watch()` /
// board.tsx `connect()` decide what a filled-in AdvancedState *means*). Split into fields + toggle
// because both forms place the ghost toggle below their primary button — the ConnectForm layout.
export interface AdvancedState {
  open: boolean;
  as: string;
  token: string;
}

/** The two credential fields, rendered only while the advanced path is open. */
export function MemberSignInFields({
  advanced,
  onAdvanced,
  seatLabel = 'Observe as (seat)',
}: {
  advanced: AdvancedState;
  onAdvanced: (a: AdvancedState) => void;
  seatLabel?: string;
}) {
  if (!advanced.open) return null;
  return (
    <>
      <label className="lc-form__field">
        <span>{seatLabel}</span>
        <input
          type="text"
          value={advanced.as}
          placeholder="your seat name"
          onChange={(e) => onAdvanced({ ...advanced, as: e.target.value })}
        />
      </label>
      <label className="lc-form__field">
        <span>Credential</span>
        <input
          type="password"
          value={advanced.token}
          placeholder="mscr_… or mskey_…"
          onChange={(e) => onAdvanced({ ...advanced, token: e.target.value })}
        />
      </label>
    </>
  );
}

/** The ghost toggle that opens/closes the advanced path. */
export function MemberSignInToggle({
  advanced,
  onAdvanced,
  openLabel = 'Advanced — connect as a specific seat',
  closeLabel = 'Use an auto observer instead',
}: {
  advanced: AdvancedState;
  onAdvanced: (a: AdvancedState) => void;
  openLabel?: string;
  closeLabel?: string;
}) {
  return (
    <button
      className="lc-form__advanced"
      onClick={() => onAdvanced({ ...advanced, open: !advanced.open })}
    >
      {advanced.open ? closeLabel : openLabel}
    </button>
  );
}
