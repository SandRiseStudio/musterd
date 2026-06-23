import { WEDGE } from '../content/roadmap.data';
import { LiquidGlass } from './LiquidGlass/LiquidGlass';
import './Wedge.css';

export function Wedge() {
  return (
    <section className="wedge shell" id="priorities">
      <div className="wedge__grid">
        <div className="wedge__copy">
          <h2 className="wedge__title">{WEDGE.heading}</h2>
          <p className="wedge__body">{WEDGE.body}</p>
          <div className="wedge__refs">
            {WEDGE.refs.map((ref) => (
              <a key={ref.label} className="wedge__ref mono" href={ref.href} target="_blank" rel="noreferrer">
                {ref.label}
              </a>
            ))}
          </div>
        </div>
        <div className="wedge__showcase">
          <LiquidGlass caption="Humans and agents, as peers." />
        </div>
      </div>
    </section>
  );
}
