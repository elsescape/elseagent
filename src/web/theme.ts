import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

const KEY = "elseagent.theme";
const systemDark = () => matchMedia("(prefers-color-scheme: dark)");

function saved(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return THEMES.find((t) => t === value) ?? "system";
  } catch {
    return "system"; // storage is off (private mode)
  }
}

const apply = (theme: Theme) =>
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && systemDark().matches),
  );

/** The chosen theme, kept in the browser. "system" follows the OS, also when it changes. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(saved);
  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // not remembered, then
    }
    if (theme !== "system") return;
    const media = systemDark();
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  return [theme, setTheme];
}
