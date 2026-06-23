import { useEffect, useRef, useState } from 'react';
import { TAGLINE } from '../../content/roadmap.data';
import './Hero.css';

export function Hero() {
  const canvasHost = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return; // CSS gradient fallback carries the warmth; no WebGL.

    let disposed = false;
    let handle: { dispose: () => void } | undefined;

    // Dynamic import keeps three.js / anime.js out of the SSR bundle entirely.
    import('./scene')
      .then(({ mountHero }) => {
        if (disposed) return;
        handle = mountHero(host);
        setReady(true);
      })
      .catch(() => {
        /* WebGL unavailable — the gradient fallback stands in. */
      });

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, []);

  return (
    <header className="hero">
      <div className="hero__ground" aria-hidden="true" />
      <div className={`hero__canvas${ready ? ' is-ready' : ''}`} ref={canvasHost} aria-hidden="true" />
      <div className="hero__vignette" aria-hidden="true" />

      <div className="hero__content shell">
        <p className="hero__eyebrow mono">SandRise Studio</p>
        <h1 className="hero__wordmark mono">
          musterd<span className="hero__cursor" aria-hidden="true">_</span>
        </h1>
        <p className="hero__tagline">{TAGLINE}</p>
        <a className="hero__scroll" href="#roadmap">
          <span>the roadmap</span>
          <span className="hero__scroll-arrow" aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}
