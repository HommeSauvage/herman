import { useCallback, useEffect, useRef, useState } from "react";

import { desktopRpc } from "../lib/desktop-rpc.js";

type MentionState = {
  open: boolean;
  items: string[];
  activeIndex: number;
  loading: boolean;
};

const SEARCH_DEBOUNCE_MS = 100;

export function useFileMention(folderPath: string | undefined) {
  const [state, setState] = useState<MentionState>({
    open: false,
    items: [],
    activeIndex: 0,
    loading: false,
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queryRef = useRef("");
  const openRef = useRef(false);

  const close = useCallback(() => {
    openRef.current = false;
    setState((s) => (s.open ? { ...s, open: false } : s));
  }, []);

  const reset = useCallback(() => {
    openRef.current = false;
    queryRef.current = "";
    setState({
      open: false,
      items: [],
      activeIndex: 0,
      loading: false,
    });
  }, []);

  const setActiveIndex = useCallback(
    (index: number) => setState((s) => ({ ...s, activeIndex: index })),
    [],
  );

  const moveActive = useCallback((delta: number) => {
    setState((s) => {
      if (s.items.length === 0) return s;
      const next = s.activeIndex + delta;
      return { ...s, activeIndex: Math.max(0, Math.min(s.items.length - 1, next)) };
    });
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    reset();
  }, [folderPath, reset]);

  const runSearch = useCallback(
    async (query: string) => {
      if (!folderPath) {
        setState((s) => ({ ...s, items: [], activeIndex: 0, loading: false }));
        return;
      }

      setState((s) => (s.loading ? s : { ...s, loading: true }));
      try {
        const { paths } = await desktopRpc.request.findProjectFiles({
          folderPath,
          query,
          includeDirectories: true,
        });
        setState((s) => ({ ...s, items: paths, activeIndex: 0, loading: false }));
      } catch (error) {
        console.error(
          "[file-mention] search failed:",
          error instanceof Error ? error.message : String(error),
        );
        setState((s) => ({ ...s, items: [], activeIndex: 0, loading: false }));
      }
    },
    [folderPath],
  );

  const onInput = useCallback(
    (query: string) => {
      queryRef.current = query;
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!openRef.current) {
        openRef.current = true;
        setState((s) => ({ ...s, open: true, loading: true }));
      }

      debounceRef.current = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  const activeItem = state.items[state.activeIndex];

  return {
    ...state,
    activeItem,
    onInput,
    close,
    reset,
    setActiveIndex,
    moveActive,
  };
}
