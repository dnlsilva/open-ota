import { Link, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./api/auth";
import { AppShell, Page } from "./components/Layout";
import { EmptyState } from "./components/EmptyState";
import { Billing } from "./routes/Billing";
import { Devices } from "./routes/Devices";
import { Login } from "./routes/Login";
import { ProjectHome } from "./routes/ProjectHome";
import { ProjectLayout } from "./routes/ProjectLayout";
import { Projects } from "./routes/Projects";
import { ReleaseDetail } from "./routes/ReleaseDetail";
import { Releases } from "./routes/Releases";
import { Settings } from "./routes/Settings";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Projects />} />
          <Route path="/p/:projectId" element={<ProjectLayout />}>
            <Route index element={<ProjectHome />} />
            <Route path="releases" element={<Releases />} />
            <Route path="releases/:releaseId" element={<ReleaseDetail />} />
            <Route path="devices" element={<Devices />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="/org/:orgId/billing" element={<Billing />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <Page>
      <div className="card">
        <EmptyState
          title="Page not found"
          action={
            <Link className="btn btn-primary" to="/">
              Back to projects
            </Link>
          }
        >
          That route does not exist in the dashboard.
        </EmptyState>
      </div>
    </Page>
  );
}
