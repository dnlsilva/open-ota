import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@open-ota/shared";
import { useAuth } from "../api/auth";
import { client, errorMessage, useProjects, useServerConfig } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/EmptyState";
import { Page } from "../components/Layout";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { formatRelative } from "../lib/format";

export function Projects() {
  const { orgs } = useAuth();
  const config = useServerConfig();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);

  const grouped = useMemo(() => {
    const byOrg = new Map<string, Project[]>();
    for (const project of projects.data?.projects ?? []) {
      const list = byOrg.get(project.orgId);
      if (list) list.push(project);
      else byOrg.set(project.orgId, [project]);
    }
    return byOrg;
  }, [projects.data]);

  return (
    <Page>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="page-sub">One project per app. Platform and channel live inside it.</div>
        </div>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          New project
        </button>
      </div>

      {projects.isPending ? <Loading label="Loading projects" /> : null}

      {projects.isError ? (
        <ErrorState message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} />
      ) : null}

      {projects.data && projects.data.projects.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No projects yet"
            command={"ota init --provider docker\nota publish -c production"}
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Create a project
              </button>
            }
          >
            A project holds the signing key, the channels and every release for one app. Create it here,
            or let the CLI create and wire it up in one command.
          </EmptyState>
        </div>
      ) : null}

      <div className="stack">
        {[...grouped.entries()].map(([orgId, list]) => {
          const org = orgs.find((candidate) => candidate.id === orgId);
          return (
            <section key={orgId} className="stack-sm">
              {orgs.length > 1 || config.data?.mode === "hosted" ? (
                <div className="row">
                  <h2>{org?.name ?? "Organization"}</h2>
                  {config.data?.billingEnabled ? (
                    <Link className="small" to={`/org/${orgId}/billing`}>
                      Plan and usage
                    </Link>
                  ) : null}
                </div>
              ) : null}
              <div className="project-list">
                {list.map((project) => (
                  <Link key={project.id} to={`/p/${project.id}`} className="project-card">
                    <div className="name">{project.name}</div>
                    <div className="small muted mono">{project.slug}</div>
                    <div className="small faint" style={{ marginTop: 6 }}>
                      Created {formatRelative(project.createdAt)}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {creating ? <CreateProjectDialog onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const { orgs } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [scheme, setScheme] = useState("");

  const create = useMutation({
    mutationFn: () =>
      client.createProject({
        name,
        orgId: orgId || undefined,
        deepLinkScheme: scheme.trim() || undefined,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast(`Project ${result.project.name} created`, "healthy");
      onClose();
      navigate(`/p/${result.project.id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-project" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create project"}
          </button>
        </>
      }
    >
      <form id="create-project" onSubmit={submit}>
        <div className="field">
          <label htmlFor="project-name">Name</label>
          <input
            id="project-name"
            type="text"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        {orgs.length > 1 ? (
          <div className="field">
            <label htmlFor="project-org">Organization</label>
            <select id="project-org" value={orgId} onChange={(event) => setOrgId(event.target.value)}>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="project-scheme">Deep link scheme (optional)</label>
          <input
            id="project-scheme"
            type="text"
            placeholder="myapp"
            value={scheme}
            onChange={(event) => setScheme(event.target.value)}
          />
          <span className="hint">
            Used by “Open on device”: the QR link opens <code>scheme://ota/preview</code>. It must match
            the scheme registered in the native app.
          </span>
        </div>

        {create.isError ? (
          <div className="error-box" role="alert">
            {errorMessage(create.error)}
          </div>
        ) : null}

        <p className="hint">
          Creating a project generates its RSA signing key pair and the default channels
          (development, staging, production).
        </p>
      </form>
    </Modal>
  );
}
