"use client";

import { useEffect, useRef, useCallback } from "react";

type MapEmbedProps = {
  src: string;
  title: string;
};

/**
 * Reliable Google Maps iframe embed.
 *
 * Root cause of the black-gap bug: Google's embed initialises its canvas
 * at the moment the iframe loads. If the container size hasn't fully
 * settled yet (e.g. a CSS Grid column is still computing from its
 * sibling's content), the canvas is initialised too small and the
 * remainder of the container shows as black.
 *
 * Fix strategy:
 * 1. The parent (MapSection) already gives this wrapper a definite pixel
 *    height on every breakpoint via explicit Tailwind classes, so the
 *    container is settled before the iframe is injected into the DOM.
 * 2. A ResizeObserver watches for any further width/height changes
 *    (e.g. mobile → desktop resize) and swaps the src to force a full
 *    re-initialisation at the new dimensions.
 */
export default function MapEmbed({ src, title }: MapEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSize = useRef({ w: 0, h: 0 });

  const reload = useCallback(() => {
    const el = iframeRef.current;
    if (!el) return;
    // Swap src through a blank page then back -- forces canvas reinit
    const real = src;
    el.src = "about:blank";
    requestAnimationFrame(() => {
      el.src = real;
    });
  }, [src]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    prevSize.current = { w: rect.width, h: rect.height };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const prev = prevSize.current;
      if (Math.abs(width - prev.w) < 4 && Math.abs(height - prev.h) < 4) return;

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        prevSize.current = { w: width, h: height };
        reload();
      }, 200);
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 w-full h-full overflow-hidden bg-charcoal"
    >
      <iframe
        ref={iframeRef}
        title={title}
        src={src}
        width="100%"
        height="100%"
        loading="lazy"
        allowFullScreen
        referrerPolicy="no-referrer-when-downgrade"
        className="block w-full h-full grayscale contrast-125"
        style={{ border: 0, margin: 0, padding: 0, display: "block" }}
      />
    </div>
  );
}
