import './Footer.css';
import { MusterdChip } from '../brand/MusterdWord';

const LINKS = [
  { label: 'GitHub', href: 'https://github.com/SandRiseStudio/musterd' },
  { label: 'SPEC', href: 'https://github.com/SandRiseStudio/musterd/blob/main/SPEC.md' },
  { label: 'ROADMAP.md', href: 'https://github.com/SandRiseStudio/musterd/blob/main/ROADMAP.md' },
];

export function Footer() {
  return (
    <footer className="footer shell">
      <div className="footer__mark">
        <span className="footer__word mono">
          <MusterdChip size={18} className="footer__chip" />
          musterd
        </span>
        <span className="footer__by">a SandRise Studio product</span>
      </div>
      <nav className="footer__links" aria-label="Footer">
        {LINKS.map((l) => (
          <a key={l.label} className="footer__link mono" href={l.href} target="_blank" rel="noreferrer">
            {l.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
