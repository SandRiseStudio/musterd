import { z } from 'zod';
import { ASK_OUTCOMES, ASK_SPECIES, ASK_TIERS } from './ask.wire.js';

/** The zod face of the ask vocabulary; the tuples, contract table and helpers are `ask.wire.js`. */
export {
  ASK_NO_ANSWER,
  ASK_OUTCOMES,
  ASK_SPECIES,
  ASK_TIERS,
  ASK_TIER_DEFAULTS,
  ASK_TOP_TIER,
  askContract,
  askContractText,
  askTierHolds,
  type AskContract,
  type AskNoAnswer,
  type AskOutcome,
  type AskSpecies,
  type AskTier,
} from './ask.wire.js';

export const AskSpeciesSchema = z.enum(ASK_SPECIES);
export const AskTierSchema = z.enum(ASK_TIERS);
export const AskOutcomeSchema = z.enum(ASK_OUTCOMES);
