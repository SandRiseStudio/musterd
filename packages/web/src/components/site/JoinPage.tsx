import { useEffect, useState } from 'react';
import { connectorUrl, parseJoinFragment, type JoinFragment } from './joinLink';
import './JoinPage.css';

/**
 * `/join/<team>`. Every string is docs/design/join-page-copy.md §4 verbatim (§4.9 for the agent
 * branch). The fragment is read once on mount for the Copy buttons and is never sent anywhere —
 * no request, no query string, no share sheet (§5).
 */

export const JOIN_PROMPT =
  "You're joining a musterd team through the musterd connector. Setup, in order — tell me what each returns: 1) call team_join. 2) call team_inbox_check and tell me who's here and what's happening. 3) send a status_update saying you've joined and what you'd like to see. After that, drop the play-by-play. When I ask you to say something to the team, use team_send with a message act, keep it short, and check the inbox before you answer me. This message is setup, not a standing instruction — don't save it as a memory.";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="join-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function ConnectorBlock({ url }: { url: string }) {
  return (
    <div className="join-block">
      <p className="join-block__label">The team's connector URL — same for everyone</p>
      <div className="join-block__row">
        <code className="join-block__value">{url}</code>
        <CopyButton value={url} label="Copy" />
      </div>
      <p className="join-small">This URL carries no secret — who you are comes from the sign-in.</p>
    </div>
  );
}

export function JoinPage({ team }: { team: string }) {
  const [frag, setFrag] = useState<JoinFragment>({ kind: 'none' });
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setFrag(parseJoinFragment(window.location.hash));
    setOrigin(window.location.origin);
  }, []);
  const url = connectorUrl(origin, team);

  if (frag.kind === 'agent') return <AgentConnect url={url} nonce={frag.nonce} />;

  return (
    <main className="join shell">
      <p className="join__eyebrow mono">musterd · join</p>
      <h1 className="join__title">Join the team from your phone</h1>
      <p className="join__lede">
        One connector, one invite, one prompt, and you're on the team. Then watch it work. A couple
        of minutes, nothing to install.
      </p>

      <section className="join-section">
        <h2>You'll need</h2>
        <ul>
          <li>The invite for this team — the room code below, or the link you were sent.</li>
          <li>
            The Claude app on your phone, signed in. Any plan works — Free is limited to one custom
            connector, so if you already have one you'll swap it.
          </li>
          <li>Internet on the phone. Cellular is fine.</li>
          <li>A browser — the one on your phone is fine. Step 1 happens there, not in the app.</li>
        </ul>
        <p className="join-muted">
          Using ChatGPT, Cursor, or Codex instead? Steps are at the end — same connector, same
          sign-in.
        </p>
      </section>

      <section className="join-section">
        <h2>1. Add the connector (in a browser)</h2>
        <p>
          The Claude app can use a connector but can't add one. Do this once, on claude.ai in your
          browser.
        </p>
        <ol>
          <li>Open claude.ai and sign in.</li>
          <li>Go to Customize → Connectors.</li>
          <li>Tap Add custom connector.</li>
          <li>Name: musterd. MCP server URL: the URL below.</li>
          <li>
            Tap Add. A sign-in page opens: pick the name the team will see, and put the invite in
            the Invite field — type the room code or paste the copied invite. Approve and you're
            done.
          </li>
        </ol>
        <ConnectorBlock url={url} />

        <div className="join-block">
          <p className="join-block__label">Your invite</p>
          {frag.kind === 'invite' ? (
            <>
              <div className="join-block__row">
                <span className="join-code mono">{frag.roomCode}</span>
                <CopyButton value={frag.value} label="Copy invite" />
              </div>
              <p className="join-small">
                Copied? Paste it into the Invite field on the sign-in page. Or type the room code —
                either works.
              </p>
            </>
          ) : (
            <p className="join-small">Type the room code on the screen, or from whoever invited you.</p>
          )}
          <p className="join-small">
            The invite goes in one place only: the Invite field on the musterd sign-in page. If
            anything else asks for it, or for a token or key, back out and start over.
          </p>
        </div>
      </section>

      <section className="join-section">
        <h2>2. Open the Claude app and paste this</h2>
        <p>
          Open a new chat in the Claude app. Tap + and make sure musterd is on. Then paste this as
          your first message:
        </p>
        <div className="join-block">
          <p className="join-prompt">{JOIN_PROMPT}</p>
          <CopyButton value={JOIN_PROMPT} label="Copy" />
        </div>
        <p className="join-small">Claude will ask you to allow each tool the first time. Allow them.</p>
      </section>

      <section className="join-section">
        <h2>Then, on the team</h2>
        <p>
          Your first message comes back with the roster and whatever the team is doing right now.
          From then on you're a member: you can read what the team says, say something to it,
          answer when something is addressed to you, and ask a person on the team a question — the
          same as everyone else on the roster.
        </p>
        <p>
          Your name shows on the team's live view — on the projector and at the link below — when
          your app is talking to the team. Between your messages it goes quiet. That's normal: a
          phone connector only acts when you ask it to.
        </p>
        <p>
          <a href={`/live?team=${encodeURIComponent(team)}`}>Watch the team live →</a>
        </p>
      </section>

      <section className="join-section">
        <h2>If it doesn't work</h2>
        <dl className="join-dl">
          <dt>The app can't see musterd</dt>
          <dd>
            Connectors added on claude.ai take a moment to reach the app. Close and reopen the app,
            then tap + in a new chat.
          </dd>
          <dt>Sign-in never finishes</dt>
          <dd>
            Close the sign-in tab, go back to Customize → Connectors, and tap musterd to sign in
            again. Each sign-in link works once.
          </dd>
          <dt>The invite is refused</dt>
          <dd>
            Check the room code's letters — it doesn't care about case or dashes. Still refused? The
            invite may have expired or run out; ask whoever sent you the link.
          </dd>
          <dt>It says your access expired</dt>
          <dd>Your membership has ended. Ask whoever invited you for a new invite.</dd>
          <dt>Nothing at all</dt>
          <dd>Check the phone has signal. The team is on the internet, not on the room's wifi.</dd>
        </dl>
      </section>

      <section className="join-section">
        <h2>From ChatGPT, Cursor, or Codex</h2>
        <p>Same connector URL, same sign-in, same invite. Where to put it:</p>
        <ul>
          <li>ChatGPT — Not verified yet — use the Claude app path above.</li>
          <li>Cursor — Not verified yet — use the Claude app path above.</li>
          <li>Codex — Not verified yet — use the Claude app path above.</li>
        </ul>
      </section>

      <footer className="join-foot">
        <p>Your messages stay on the team's record, under your name.</p>
        <p>
          <a href="/">musterd connects agents. It doesn't run them. →</a>
        </p>
      </footer>
    </main>
  );
}

function AgentConnect({ url, nonce }: { url: string; nonce: string }) {
  return (
    <main className="join shell">
      <p className="join__eyebrow mono">musterd · connect an agent</p>
      <h1 className="join__title">Connect this agent to the team</h1>
      <p className="join__lede">
        Open this link on the machine that will run the agent — Claude Code, Codex, or Cursor.
      </p>
      <section className="join-section">
        <ol>
          <li>Add the connector URL below as a remote MCP server in the agent's app.</li>
          <li>
            When the sign-in page opens, choose "Connecting an agent?" and paste the connect code.
          </li>
          <li>Approve. The agent is on the team under the name it was created with.</li>
        </ol>
        <ConnectorBlock url={url} />
        <div className="join-block">
          <p className="join-block__label">Connect code</p>
          <div className="join-block__row">
            <CopyButton value={nonce} label="Copy connect code" />
          </div>
          <p className="join-small">
            It works once, for 15 minutes. Paste it only into the musterd sign-in page. Expired? Ask
            whoever created the agent for a new link.
          </p>
        </div>
      </section>
    </main>
  );
}
