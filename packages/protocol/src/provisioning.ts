import { z } from 'zod';

/**
 * Strict local provisioning, ledger, journal, and lease contracts (ADR 281/282/286).
 *
 * These schemas describe machine-local files only — nothing here crosses the wire, so
 * `PROTOCOL_VERSION` is untouched. They are the write-side and read-side boundary for the
 * multi-harness reconciler: every reader classifies a file as missing/legacy/valid/invalid
 * (see {@link LocalLoad}), and every writer validates the complete intended object through the
 * matching schema before canonical serialization and atomic publication. All objects are strict —
 * an unknown key is `invalid`, never silently carried or stripped.
 */

/**
 * A harness id — the selection vocabulary (`claude-code`, `cursor`, `codex`, `musterd`, and any
 * future adapter id). Bounded machine token, not a display name. The schema deliberately does NOT
 * consult the installed adapter registry: an id this CLI build doesn't know still parses, so a
 * newer machine's selection never corrupts an older machine's files (ADR 281).
 */
export const HarnessIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** One reader-side schema violation — path and message only, never file contents or secrets. */
export const LocalStateIssueSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict();

export type LocalStateIssue = z.infer<typeof LocalStateIssueSchema>;

/**
 * The discriminated result every local-state loader returns instead of collapsing parse failures
 * to absence (ADR 282). `legacy` is reserved for a RECOGNIZED previous shape (e.g. the version-1
 * identity that carried `surface`); an unrecognized version, unknown field, malformed value, or
 * invalid JSON is `invalid`, never `legacy`. Only a confirmed `musterd harness configure` may
 * convert `legacy`; ordinary commands report both with a repair message.
 */
export type LocalLoad<T> =
  | { kind: 'missing' }
  | { kind: 'legacy'; value: unknown }
  | { kind: 'valid'; value: T }
  | { kind: 'invalid'; issues: readonly LocalStateIssue[] };

const uniqueStrings = (values: string[]): boolean => new Set(values).size === values.length;

/**
 * The ignored `.musterd/provisioned.json`, version 2 (ADR 281): what THIS worktree wants
 * (`desired`, unique harness ids) and which ledger fragments it contributes to. Shape and
 * uniqueness only — canonical registry ordering of `desired` belongs to CLI serialization, and
 * `contributions` is participation evidence, never a physical receipt that could authorize
 * removal on its own. Stores no key, grant, credential, config body, or environment value.
 */
export const WorktreeProvisioningSchema = z
  .object({
    version: z.literal(2),
    /** The provisioned workspace profile (né role-template projection — the ADR 272 revision
     *  renames the local concept to "profile"; v2 mints the field under its final name so the
     *  strict schema never needs a field migration). Empty string means generalist. */
    profile: z.string(),
    desired: z.array(HarnessIdSchema).refine(uniqueStrings, { message: 'desired ids must be unique' }),
    /** Fragment resource keys this worktree contributes to, per harness. */
    contributions: z.record(HarnessIdSchema, z.array(z.string())),
    provisionedAt: z.string().min(1),
  })
  .strict();

export type WorktreeProvisioning = z.infer<typeof WorktreeProvisioningSchema>;

/** Where a fragment physically lives — decides its resource-key discriminator and lock container. */
export const FragmentScopeSchema = z.enum(['folder', 'repo-shared', 'machine']);

export type FragmentScope = z.infer<typeof FragmentScopeSchema>;

/**
 * One machine-ledger fragment record (ADR 282): durable ownership evidence for a single managed
 * fragment. `owners` are normalized real worktree roots — local coordination identifiers, not
 * Team identity. Fingerprints are adapter-defined SHA-256 hashes of the canonical fragment
 * representation, not of whole containing files.
 */
export const LedgerFragmentSchema = z
  .object({
    harness: HarnessIdSchema,
    scope: FragmentScopeSchema,
    /** Identifies the physical config container, for locking. */
    containerKey: z.string().min(1),
    /** Identifies the independently managed subtree or marked block inside the container. */
    fragmentKey: z.string().min(1),
    fingerprint: z.string().min(1),
    owners: z
      .array(z.string().min(1))
      .refine(uniqueStrings, { message: 'owner paths must be unique' }),
    adapterVersion: z.number().int().positive(),
  })
  .strict();

export type LedgerFragment = z.infer<typeof LedgerFragmentSchema>;

/**
 * The chmod-600 machine fragment ledger under the musterd config root — cross-worktree ownership
 * coordination (ADR 282). Keyed by stable fragment resource key. A version-1 receipt from the
 * single-harness era is NOT ownership evidence; absent durable evidence, an existing physical
 * fragment is re-observed as unmanaged.
 */
export const FragmentLedgerSchema = z
  .object({
    version: z.literal(1),
    fragments: z.record(z.string(), LedgerFragmentSchema),
  })
  .strict();

export type FragmentLedger = z.infer<typeof FragmentLedgerSchema>;

/**
 * One write-ahead journal record — a single `prepared` fragment operation (ADR 282). Published
 * atomically BEFORE the external mutation; recovery compares the observed fragment fingerprint
 * against `oldFingerprint` (retry) and `intendedFingerprint` (finalize); neither match preserves
 * the journal and reports conflict. Only the two fingerprints are nullable: `null` means "fragment
 * absent" on the respective side of the operation.
 */
export const ReconcileJournalSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().min(1),
    action: z.enum(['create', 'remove', 'add-owner', 'release-owner']),
    harness: HarnessIdSchema,
    containerKey: z.string().min(1),
    resourceKey: z.string().min(1),
    oldFingerprint: z.string().min(1).nullable(),
    intendedFingerprint: z.string().min(1).nullable(),
    oldOwners: z.array(z.string().min(1)),
    intendedOwners: z.array(z.string().min(1)),
    worktreeRoot: z.string().min(1),
    phase: z.literal('prepared'),
  })
  .strict();

export type ReconcileJournal = z.infer<typeof ReconcileJournalSchema>;

/**
 * A cross-process recoverable lease record, keyed by container (ADR 282/286). Not an in-memory
 * mutex: a successor may reclaim only an EXPIRED lease whose recorded PID + process-start identity
 * are provably no longer live — unknown liveness stays busy — so a crashed holder cannot strand
 * journal recovery. `holderId` is opaque; `processStartedAt` is the platform's process-start
 * string used to distinguish PID reuse.
 */
export const HarnessLockRecordSchema = z
  .object({
    version: z.literal(1),
    holderId: z.string().min(1),
    pid: z.number().int().positive(),
    processStartedAt: z.string().min(1),
    acquiredAt: z.string().datetime(),
    renewedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type HarnessLockRecord = z.infer<typeof HarnessLockRecordSchema>;
