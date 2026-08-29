import { useState } from "react";
import type { FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiToken, TokenScope } from "@open-ota/shared";
import { client, errorMessage, qk, useChannels, useProject, useTokens } from "../api/client";
import { CopyButton, CopyRow } from "../components/CopyButton";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Pill } from "../components/StatPill";
import { DataTable } from "../components/Table";
import { useToast } from "../components/Toast";
import { formatRelative } from "../lib/format";

export function Settings() {
  const { projectId } = useParams();
  const project = useProject(projectId);

  return (
    <div className="stack">
      <ChannelsCard projectId={projectId ?? ""} />
      <TokensCard projectId={projectId ?? ""} />

      <section className="card">
        <div className="card-head">
          <h2>Keys and deep link</h2>
        </div>
        <div className="card-body stack">
          {project.isPending ? <Loading label="Loading project settings" /> : null}
          {project.isError ? (
            <ErrorState message={errorMessage(project.error)} onRetry={() => void project.refetch()} />
          ) : null}
          {project.data ? (
            <>
              <div className="stack-sm">
                <h3>App key</h3>
                <p className="hint">
                  Public by design: it identifies the project on the Device API and authorises nothing.
                  The config plugin embeds it in the binary.
                </p>
                <CopyRow value={project.data.project.appKey} what="App key copied" />
              </div>

              <div className="stack-sm">
                <h3>Project public key</h3>
                <p className="hint">
                  Every manifest is signed with this project&apos;s private key, which never leaves the
                  server. <code>ota init</code> writes the public half into <code>ota.config.json</code>{" "}
                  and the config plugin embeds it, so the device verifies before it ever executes a
                  bundle.
                </p>
                <CopyRow value={project.data.project.publicKey} what="Public key copied" multiline />
              </div>

              <div className="stack-sm">
                <h3>Deep link scheme</h3>
                <p className="hint">
                  Used by “Open on device”. It must match the URL scheme registered in the native app —
                  set it with <code>ota init</code> so the config plugin and the server agree.
                </p>
                {project.data.project.deepLinkScheme ? (
                  <CopyRow
                    value={`${project.data.project.deepLinkScheme}://ota/preview`}
                    what="Deep link copied"
                  />
                ) : (
                  <div className="notice tone-warning">
                    No scheme configured. QR previews cannot open the app until one is set.
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ChannelsCard({ projectId }: { projectId: string }) {
  const channels = useChannels(projectId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => client.createChannel(projectId, name.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.channels(projectId) });
      toast(`Channel ${name.trim()} created`, "healthy");
      setName("");
    },
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Channels</h2>
        <span className="spacer" />
        <span className="small muted">A release belongs to exactly one channel</span>
      </div>
      <div className="card-body stack">
        {channels.isPending ? <Loading label="Loading channels" /> : null}
        {channels.isError ? (
          <ErrorState message={errorMessage(channels.error)} onRetry={() => void channels.refetch()} />
        ) : null}

        {channels.data ? (
          channels.data.channels.length === 0 ? (
            <EmptyState title="No channels">
              Projects normally start with development, staging and production.
            </EmptyState>
          ) : (
            <div className="row row-wrap">
              {channels.data.channels.map((channel) => (
                <span key={channel.id} className="chip">
                  {channel.name}
                </span>
              ))}
            </div>
          )
        ) : null}

        <form className="filters" onSubmit={submit}>
          <div className="field">
            <label htmlFor="channel-name">New channel</label>
            <input
              id="channel-name"
              type="text"
              placeholder="qa"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button type="submit" className="btn" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Add channel"}
          </button>
        </form>
        <p className="hint">
          Devices ask for a channel by name (<code>OpenOta.setChannel(&quot;qa&quot;)</code>), so a new
          channel starts serving as soon as a release is promoted into it.
        </p>
      </div>
    </section>
  );
}

function TokensCard({ projectId }: { projectId: string }) {
  const tokens = useTokens(projectId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const revoke = useMutation({
    mutationFn: (token: ApiToken) => client.deleteToken(token.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.tokens(projectId) });
      toast("Token revoked", "healthy");
      setRevoking(null);
    },
    onError: (error) => toast(errorMessage(error), "critical"),
  });

  return (
    <section className="card">
      <div className="card-head">
        <h2>API tokens</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          Create token
        </button>
      </div>

      <div className="card-body tight">
        {tokens.isPending ? <Loading label="Loading tokens" /> : null}
        {tokens.isError ? (
          <div style={{ padding: 14 }}>
            <ErrorState message={errorMessage(tokens.error)} onRetry={() => void tokens.refetch()} />
          </div>
        ) : null}

        {tokens.data ? (
          <DataTable
            rows={tokens.data.tokens}
            minWidth={560}
            rowKey={(token) => token.id}
            empty={
              <EmptyState
                title="No API tokens"
                command="ota login"
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                    Create token
                  </button>
                }
              >
                The CLI, CI and the MCP server all authenticate with the same bearer token. Create one
                per consumer so it can be revoked on its own.
              </EmptyState>
            }
            columns={[
              { key: "name", header: "Name", render: (token) => token.name },
              {
                key: "scopes",
                header: "Scopes",
                render: (token) => (
                  <div className="row row-wrap">
                    {token.scopes.map((scope) => (
                      <Pill key={scope} tone={scope === "admin" ? "accent" : "neutral"} dot={false}>
                        {scope}
                      </Pill>
                    ))}
                  </div>
                ),
              },
              {
                key: "scope",
                header: "Access",
                render: (token) => (token.projectId ? "This project" : "All projects in the org"),
              },
              {
                key: "lastUsed",
                header: "Last used",
                align: "end",
                render: (token) => (
                  <span className="muted" title={token.lastUsedAt ?? undefined}>
                    {formatRelative(token.lastUsedAt)}
                  </span>
                ),
              },
              {
                key: "created",
                header: "Created",
                align: "end",
                render: (token) => (
                  <span className="muted" title={token.createdAt}>
                    {formatRelative(token.createdAt)}
                  </span>
                ),
              },
              {
                key: "actions",
                header: <span className="sr-only">Actions</span>,
                align: "end",
                render: (token) => (
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setRevoking(token)}>
                    Revoke
                  </button>
                ),
              },
            ]}
          />
        ) : null}
      </div>

      {creating ? (
        <CreateTokenDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
          }}
        />
      ) : null}

      {created ? <TokenRevealDialog token={created} onClose={() => setCreated(null)} /> : null}

      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          confirmLabel="Revoke token"
          busy={revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={() => revoke.mutate(revoking)}
        >
          Anything still using this token — CI, the CLI, an MCP client — stops being able to publish or
          read immediately. This cannot be undone.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function CreateTokenDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (token: ApiToken) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("admin");

  const create = useMutation({
    mutationFn: () => client.createToken(projectId, name.trim(), [scope]),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: qk.tokens(projectId) });
      onCreated(result.token);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Modal
      title="Create API token"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-token" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create token"}
          </button>
        </>
      }
    >
      <form id="create-token" onSubmit={submit}>
        <div className="field">
          <label htmlFor="token-name">Name</label>
          <input
            id="token-name"
            type="text"
            required
            autoFocus
            placeholder="GitHub Actions"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <span className="hint">Name it after what will use it, so revoking is unambiguous.</span>
        </div>

        <div className="field">
          <label htmlFor="token-scope">Scope</label>
          <select id="token-scope" value={scope} onChange={(event) => setScope(event.target.value as TokenScope)}>
            <option value="admin">admin — publish, promote, rollout, rollback</option>
            <option value="read">read — metrics and release listings only</option>
          </select>
        </div>

        {create.isError ? (
          <div className="error-box" role="alert">
            {errorMessage(create.error)}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function TokenRevealDialog({ token, onClose }: { token: ApiToken; onClose: () => void }) {
  const secret = token.token ?? "";

  return (
    <Modal
      title="Copy your token now"
      onClose={onClose}
      wide
      footer={
        <>
          <CopyButton value={secret} label="Copy token" what="Token copied" className="btn btn-primary" />
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="notice tone-warning">
          <strong>This is the only time the token is shown.</strong> Only a hash is stored, so it cannot
          be recovered — if it is lost, revoke it and create another.
        </div>
        {secret ? (
          <CopyRow value={secret} what="Token copied" multiline />
        ) : (
          <div className="error-box">The server did not return the token value.</div>
        )}
        <div className="stack-sm">
          <h3>Use it</h3>
          <pre
            style={{
              margin: 0,
              padding: 10,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              overflowX: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >{`export OTA_TOKEN=${secret || "ota_..."}
ota publish -c staging --rollout 10`}</pre>
        </div>
      </div>
    </Modal>
  );
}
