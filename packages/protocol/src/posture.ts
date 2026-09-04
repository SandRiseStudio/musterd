import { z } from 'zod';
import { POSTURES_ON_WIRE, normalizePosture } from './posture.wire.js';

/** The zod face of {@link POSTURES}; the tuples and `resolvePosture` live in `posture.wire.js`. */
export {
  POSTURES,
  POSTURES_ON_WIRE,
  normalizePosture,
  resolvePosture,
  type Posture,
  type PostureInput,
} from './posture.wire.js';

export const PostureSchema = z.enum(POSTURES_ON_WIRE).transform(normalizePosture);
