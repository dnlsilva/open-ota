import { Link, NavLink, Outlet, useParams } from "react-router-dom";
import { errorMessage, useProject } from "../api/client";
import { CopyButton } from "../components/CopyButton";
import { ErrorState, Loading } from "../components/EmptyState";

export function ProjectLayout() {
  const { projectId } = useParams();
  const project = useProject(projectId);

  return (
    <>
      <nav className="subnav" aria-label="Project sections">
        <NavLink to={`/p/${projectId}`} end>
          Overview
        </NavLink>
        <NavLink to={`/p/${projectId}/releases`}>Releases</NavLink>
        <NavLink to={`/p/${projectId}/devices`}>Devices</NavLink>
        <NavLink to={`/p/${projectId}/settings`}>Settings</NavLink>
      </nav>

      <main className="main">
        {project.isPending ? <Loading label="Loading project" /> : null}

        {project.isError ? (
          <ErrorState
            title="Could not load this project"
            message={errorMessage(project.error)}
            onRetry={() => void project.refetch()}
            secondary={
              <Link className="btn" to="/">
                Back to projects
              </Link>
            }
          />
        ) : null}

        {project.data ? (
          <>
            <div className="page-head">
              <div>
                <div className="crumbs small">
                  <Link to="/">Projects</Link>
                  <span className="sep">/</span>
                  <strong>{project.data.project.name}</strong>
                </div>
                <h1>{project.data.project.name}</h1>
              </div>
              <span className="spacer" />
              <div className="row">
                <span className="chip mono" title="Public app key embedded in the binary">
                  {project.data.project.appKey}
                </span>
                <CopyButton
                  value={project.data.project.appKey}
                  label="Copy app key"
                  what="App key copied"
                  className="btn btn-ghost btn-sm"
                />
              </div>
            </div>
            <Outlet />
          </>
        ) : null}
      </main>
    </>
  );
}
