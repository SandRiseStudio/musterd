import { useEffect, useRef } from 'react';
import './LiquidGlass.css';

/**
 * A single, contained liquid-glass showcase — the tasteful accent, not a page-wide effect.
 * The bounded stage holds a scene (gradient + drifting orb + caption); a draggable lens
 * refracts a cloned copy of it. Client-only and reduced-motion aware: when motion is off, the
 * stage shows as a still gradient panel and no lens engine runs.
 */
export function LiquidGlass({ caption }: { caption: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const lensClip = useRef<HTMLDivElement>(null);
  const blurWrap = useRef<HTMLDivElement>(null);
  const refraction = useRef<HTMLDivElement>(null);
  const tintLayer = useRef<HTMLDivElement>(null);
  const glintLayer = useRef<HTMLDivElement>(null);
  const housing = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const els = {
      stage: stage.current,
      scene: scene.current,
      lens: lens.current,
      lensClip: lensClip.current,
      blurWrap: blurWrap.current,
      refraction: refraction.current,
      tintLayer: tintLayer.current,
      glintLayer: glintLayer.current,
      housing: housing.current,
    };
    if (Object.values(els).some((e) => e === null)) return;

    let handle: { dispose: () => void } | undefined;
    let disposed = false;
    import('./engine')
      .then(({ createLiquidGlass }) => {
        if (disposed) return;
        handle = createLiquidGlass(els as Parameters<typeof createLiquidGlass>[0]);
        stage.current?.classList.add('is-live');
      })
      .catch(() => {
        /* no-op — the still stage stands in */
      });

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, []);

  return (
    <div className="lg-stage" ref={stage}>
      <div className="lg-scene" ref={scene}>
        <div className="lg-bg" />
        <div className="lg-orb" data-lg-orb />
        <p className="lg-caption mono">{caption}</p>
      </div>

      <div className="lg-lens" ref={lens} aria-hidden="true">
        <div className="lg-lens-clip" ref={lensClip}>
          <div className="lg-blur" ref={blurWrap}>
            <div className="lg-refraction" ref={refraction} />
          </div>
          <div className="lg-tint" ref={tintLayer} />
          <div className="lg-glint" ref={glintLayer} />
        </div>
      </div>

      <svg className="lg-housing" ref={housing} width="0" height="0" aria-hidden="true" />
      <span className="lg-hint mono">drag the glass</span>
    </div>
  );
}
