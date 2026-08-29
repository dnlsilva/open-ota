import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Org } from "@open-ota/shared";
import { client, errorMessage, qk, readStoredToken, setAuthToken, setUnauthorizedHandler, useMe } from "./client";
import { ErrorState, Loading } from "../components/EmptyState";

interface AuthUser {
  id: string;
  email: string;
}

interface AuthValue {
  token: string | undefined;
  user: AuthUser | undefined;
  orgs: Org[];
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | undefined>(() => readStoredToken());
  const me = useMe(Boolean(token));

  const logout = useCallback(() => {
    // Guarded so a 401 on a public endpoint (e.g. /config on the login screen)
    // cannot clear the cache in a loop when there is no session to drop.
    if (!client.token) return;
    setAuthToken(undefined);
    setToken(undefined);
    queryClient.clear();
  }, [queryClient]);

  // A 401 from any request drops the session; RequireAuth then routes to /login.
  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(() => {});
  }, [logout]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await client.login(email, password);
      setAuthToken(result.token);
      setToken(result.token);
      queryClient.setQueryData(qk.me, { user: result.user, orgs: result.orgs });
    },
    [queryClient],
  );

  const value = useMemo<AuthValue>(
    () => ({ token, user: me.data?.user, orgs: me.data?.orgs ?? [], login, logout }),
    [token, me.data, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

/** Route guard: waits for /auth/me so the shell never renders a half-known user. */
export function RequireAuth() {
  const { token, logout } = useAuth();
  const location = useLocation();
  const me = useMe(Boolean(token));

  if (!token) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  if (me.isPending) return <Loading label="Loading your account" />;

  if (me.isError) {
    return (
      <div className="main">
        <ErrorState
          title="Could not load your account"
          message={errorMessage(me.error)}
          onRetry={() => void me.refetch()}
          secondary={
            <button type="button" className="btn" onClick={logout}>
              Sign out
            </button>
          }
        />
      </div>
    );
  }

  return <Outlet />;
}
