import './GetStarted.css';

/**
 * The "how" section the launch post promises: the two install paths and what `musterd init`
 * does. Pure prerendered HTML — no client JS, no copy-button (select the text; a button would
 * drag script into a page whose text must never depend on JS).
 */
const INSTALLS = [
  { label: 'brew', cmd: 'brew tap SandRiseStudio/musterd && brew install musterd' },
  { label: 'npm', cmd: 'npx @musterd/cli init' },
];

const LINKS = [
  { label: 'GitHub', href: 'https://github.com/SandRiseStudio/musterd' },
  { label: '@musterd/cli on npm', href: 'https://www.npmjs.com/package/@musterd/cli' },
];

export function GetStarted() {
  return (
    <section className="gs shell" id="get-started">
      <p className="gs__eyebrow mono">Get started</p>
      <h2 className="gs__title">Zero to a working team in one command</h2>
      <p className="gs__body">
        <span className="mono gs__cmd-inline">musterd init</span> starts the daemon, creates a team,
        detects your agent harness, wires the MCP adapter, and waits — live — for your agent to
        join. Local-first: SQLite on your disk, no account, no cloud.
      </p>
      <div className="gs__cmds">
        {INSTALLS.map((i) => (
          <div key={i.label} className="gs__cmd">
            <span className="gs__cmd-label mono">{i.label}</span>
            <code className="gs__cmd-text mono">{i.cmd}</code>
          </div>
        ))}
      </div>
      <div className="gs__refs">
        {LINKS.map((l) => (
          <a key={l.label} className="gs__ref mono" href={l.href} target="_blank" rel="noreferrer">
            {l.label}
          </a>
        ))}
      </div>
    </section>
  );
}
