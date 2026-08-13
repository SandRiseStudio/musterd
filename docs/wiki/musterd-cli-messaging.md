# musterd CLI messaging from a shell

Never put backticks or `$()` in a `musterd send` body issued via a shell — command substitution runs even inside double quotes and splices the output into the sent message.

## The incident (2026-06-29; falsify: send a single-quoted test body containing a backtick command)

A message containing a backticked `musterd inbox --wait` executed the command and dumped the full inbox listing into the sent body (1563 chars vs ~280 typed). It polluted real team history — musterd has no edit/supersede primitive for a sent act, and the live firehose renders bodies verbatim.

## The rule

Wrap bodies in single quotes so nothing is interpreted, write command references as plain words, or put the body in a file. (Seats using the `team_send` MCP tool are unaffected — no shell in the path.)
