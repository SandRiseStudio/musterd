/**
 * The `musterd` CLI usage text. Now derived from the structured command catalog (help/catalog.ts) via
 * help/plain.ts, but kept exported from this module under the name `HELP` because the guidance drift
 * check (`scripts/check-guidance.ts` / `pnpm guidance:check`) imports `{ HELP }` from here and asserts
 * every command the skill names still appears as a `musterd <cmd>` substring (ADR 085). The pretty,
 * grouped, colorized help lives in render/help.ts; this is the plain form the check reads.
 */
import { renderPlainHelp } from './help/plain.js';

export const HELP: string = renderPlainHelp();
