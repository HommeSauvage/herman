import { useCallback, useEffect, useRef, useState } from "react";

interface UseAutoScrollOptions {
  scrollRef: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
}

/**
 * Keeps the bottom of a scrollable region in view while content is streaming,
 * but stops auto-following as soon as the user scrolls up. Auto-follow resumes
 * when the user scrolls back to the bottom.
 *
 * Also toggles `overflow-anchor` to prevent the browser from fighting
 * intentional scroll holds while auto-following.
 */
export function useAutoScroll(options: UseAutoScrollOptions) {
  const { scrollRef, enabled = true } = options;
  const [userScrolled, setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);
  const autoScrollMarkerRef = useRef<{ top: number; time: number } | undefined>(undefined);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setUserScrolledState = useCallback((value: boolean) => {
    if (userScrolledRef.current === value) return;
    userScrolledRef.current = value;
    setUserScrolled(value);
  }, []);

  const updateOverflowAnchor = useCallback((el: HTMLElement) => {
    el.style.overflowAnchor = userScrolledRef.current ? "auto" : "none";
  }, []);

  const isNearBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
  }, []);

  const scrollToBottom = useCallback(
    (force = false) => {
      if (!enabled) return;
      if (!force && userScrolledRef.current) return;

      const el = scrollRef.current;
      if (!el) return;

      const top = Math.max(0, el.scrollHeight - el.clientHeight);
      autoScrollMarkerRef.current = { top, time: Date.now() };
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
      autoTimerRef.current = setTimeout(() => {
        autoScrollMarkerRef.current = undefined;
        autoTimerRef.current = undefined;
      }, 1500);

      el.scrollTop = top;
      updateOverflowAnchor(el);
    },
    [enabled, scrollRef, updateOverflowAnchor],
  );

  const resume = useCallback(() => {
    setUserScrolledState(false);
    scrollToBottom(true);
  }, [setUserScrolledState, scrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setUserScrolledState(true);
    };

    const handleScroll = () => {
      if (!userScrolledRef.current) {
        const marker = autoScrollMarkerRef.current;
        if (marker && Date.now() - marker.time < 1500 && Math.abs(el.scrollTop - marker.top) < 2) {
          return;
        }
      }

      if (isNearBottom(el)) {
        setUserScrolledState(false);
      } else {
        setUserScrolledState(true);
      }
      updateOverflowAnchor(el);
    };

    el.addEventListener("wheel", handleWheel, { passive: true });
    el.addEventListener("scroll", handleScroll, { passive: true });
    updateOverflowAnchor(el);

    return () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("scroll", handleScroll);
      el.style.overflowAnchor = "";
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, [enabled, scrollRef, setUserScrolledState, updateOverflowAnchor, isNearBottom]);

  return { scrollToBottom, userScrolled, resume };
}
