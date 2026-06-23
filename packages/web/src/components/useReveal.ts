import { useEffect, useRef } from 'react';

/**
 * Adds `data-reveal="in"` when the element scrolls into view, once. CSS handles the
 * transition (with a per-item delay), and reduced-motion users get it revealed instantly.
 * Lightweight on purpose — the content stays readable and prerender-friendly.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.dataset.reveal = 'in';
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.dataset.reveal = 'in';
            io.unobserve(el);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return ref;
}
