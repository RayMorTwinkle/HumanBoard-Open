import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "humanboard.theme";
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let current: Theme = typeof window === "undefined" ? "light" : stored();

export function applyTheme(theme: Theme = current): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be unavailable; the theme still applies for this session.
  }
  listeners.forEach((fn) => fn());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => "light",
  );
}

/** Canvas overlay colors are baked into SVG data URLs, so they need literal values. */
export const CANVAS_INK = {
  light: { selection: "#2f6fde", handle: "#ffffff" },
  dark: { selection: "#7aa2ff", handle: "#1c1c1f" },
} as const;
