import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth";
import { apiBaseUrl, client, errorMessage, useServerConfig } from "../api/client";
import { ThemeToggle } from "../components/Layout";

export function Login() {
  const { token, login } = useAuth();
  const config = useServerConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const next = (location.state as { from?: string } | null)?.from ?? "/";

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (token) return <Navigate to={next} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const result = await client.signup(email, password, orgName);
        if (result.verificationRequired) {
          setNotice(`Account created. Check ${email} for the verification link, then sign in.`);
          setMode("login");
          return;
        }
      }
      await login(email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const signupAvailable = config.data?.signupEnabled ?? false;

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="brand-mark" aria-hidden="true">
            OTA
          </span>
          <strong>Open OTA</strong>
          <span className="spacer" />
          <ThemeToggle />
        </div>

        <h1>{mode === "login" ? "Sign in" : "Create an account"}</h1>
        <p className="hint" style={{ marginBottom: 16 }}>
          {apiBaseUrl}
        </p>

        <form onSubmit={submit}>
          {mode === "signup" ? (
            <div className="field">
              <label htmlFor="orgName">Organization name</label>
              <input
                id="orgName"
                type="text"
                required
                autoComplete="organization"
                value={orgName}
                onChange={(event) => setOrgName(event.target.value)}
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? (
            <div className="error-box" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </div>
          ) : null}

          {notice ? (
            <div className="notice" role="status" style={{ marginBottom: 12 }}>
              {notice}
            </div>
          ) : null}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        {signupAvailable ? (
          <p className="hint" style={{ marginTop: 14, textAlign: "center" }}>
            {mode === "login" ? "No account yet? " : "Already have an account? "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? "Sign up" : "Sign in"}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
