import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../api/auth";
import { useServerConfig } from "../api/client";

type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "ota.theme";

function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_GLYPH: Record<ThemeChoice, string> = { system: "◐", light: "☀", dark: "☾" };

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  useEffect(() => {
    try {
      if (theme === "system") {
        delete document.documentElement.dataset.theme;
        localStorage.removeItem(THEME_KEY);
      } else {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem(THEME_KEY, theme);
      }
    } catch {
      /* storage unavailable — the attribute still applies for this session */
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => setTheme(NEXT_THEME[theme])}
      aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}.`}
      title={`Theme: ${theme} — click for ${NEXT_THEME[theme]}`}
    >
      <span aria-hidden="true">{THEME_GLYPH[theme]}</span>
    </button>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <main className="main">{children}</main>;
}

export function AppShell() {
  const { user, orgs, logout } = useAuth();
  const config = useServerConfig();
  const billingOrg = orgs[0];

  return (
    <div className="app">
      <header className="appbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            OTA
          </span>
          Open OTA
        </Link>
        <span className="spacer" />
        {config.data?.billingEnabled && billingOrg ? (
          <Link to={`/org/${billingOrg.id}/billing`} className="btn btn-ghost btn-sm">
            Billing
          </Link>
        ) : null}
        <ThemeToggle />
        {user ? (
          <>
            <span className="small muted" title={user.email}>
              {user.email}
            </span>
            <button type="button" className="btn btn-sm" onClick={logout}>
              Sign out
            </button>
          </>
        ) : null}
      </header>
      <Outlet />
    </div>
  );
}
