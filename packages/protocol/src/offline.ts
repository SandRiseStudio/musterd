import { z } from 'zod';
import { OFFLINE_REASONS } from './offline.wire.js';

/** The zod face of {@link OFFLINE_REASONS}; the tuple and resolver live in `offline.wire.js`. */
export {
  OFFLINE_REASONS,
  STICKY_OFFLINE_REASONS,
  resolveOfflineReason,
  type OfflineReason,
  type OfflineReasonInput,
} from './offline.wire.js';

export const OfflineReasonSchema = z.enum(OFFLINE_REASONS);
