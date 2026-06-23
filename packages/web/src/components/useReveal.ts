import { useEffect, useLayoutEffect, useRef } from 'react';

// useLayoutEffect on the client (hide before first paint → no flash), useEffect on the
// server (no SSR warning; it doesn't run there anyway).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Scroll-reveal as progressive enhancement. The element renders VISIBLE in HTML
 * (data-reveal="in"), so prerendered content is readable with no JS. Only when JS runs and
 * motion is allowed do we hide it and animate it back in as it scrolls into view. Reduced-motion
 * and no-JS both leave it visible.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !('IntersectionObserver' in window)) {
      el.dataset.reveal = 'in';
      return;
    }

    el.dataset.reveal = 'out'; // hide before paint; animate in on intersect
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.dataset.reveal = 'in';
            io.unobserve(el);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return ref;
}
