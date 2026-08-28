/**
 * Wrapper that confirms the bundle booted. Without a notifyAppReady() the
 * native side treats the launch as a crash and rolls back on the next start,
 * so the default is to confirm right after the first frame — late enough to
 * prove React mounted, early enough that a slow screen does not look like a
 * crash. Apps that would rather confirm after their own first data load pass
 * `autoNotifyReady={false}` and call OpenOta.notifyAppReady() themselves.
 */

import * as React from "react";
import { OpenOta } from "./OpenOta.js";
import { installPreviewHandler } from "./preview.js";
import type { DownloadProgress, SyncResult } from "./types.js";

export interface OtaProviderProps {
  children?: React.ReactNode;
  /** Set false to confirm the launch yourself. */
  autoNotifyReady?: boolean;
  /** Runs sync() once on mount. */
  syncOnLaunch?: boolean;
  onSyncResult?: (result: SyncResult) => void;
  /** Rendered above children while a bundle is downloading. */
  renderProgress?: (progress: DownloadProgress) => React.ReactNode;
}

export function OtaProvider({
  children,
  autoNotifyReady = true,
  syncOnLaunch = true,
  onSyncResult,
  renderProgress,
}: OtaProviderProps): React.ReactElement {
  const [progress, setProgress] = React.useState<DownloadProgress | null>(null);

  React.useEffect(() => {
    if (!autoNotifyReady) return;
    return afterFirstFrame(() => {
      void OpenOta.notifyAppReady();
    });
  }, [autoNotifyReady]);

  React.useEffect(() => {
    const preview = installPreviewHandler();
    return () => preview.remove();
  }, []);

  React.useEffect(() => {
    if (!renderProgress) return;
    const subscription = OpenOta.addListener("downloadProgress", setProgress);
    return () => subscription.remove();
  }, [renderProgress]);

  React.useEffect(() => {
    if (!syncOnLaunch) return;
    let cancelled = false;
    void OpenOta.sync().then((result) => {
      if (cancelled) return;
      setProgress(null);
      onSyncResult?.(result);
    });
    return () => {
      cancelled = true;
    };
    // onSyncResult is intentionally not a dependency: sync runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOnLaunch]);

  return (
    <>
      {progress && renderProgress ? renderProgress(progress) : null}
      {children}
    </>
  );
}

/** `OpenOta.wrap(App)` — the zero-config form of <OtaProvider>. */
export function wrap<P extends object>(
  App: React.ComponentType<P>,
  options: Omit<OtaProviderProps, "children"> = {},
): React.ComponentType<P> {
  const Wrapped: React.FC<P> = (props) => (
    <OtaProvider {...options}>
      <App {...props} />
    </OtaProvider>
  );
  Wrapped.displayName = `withOpenOta(${App.displayName ?? App.name ?? "App"})`;
  return Wrapped;
}

/**
 * requestAnimationFrame fires once the first frame is scheduled; the nested
 * timeout lets that frame actually paint before we call it a successful boot.
 */
function afterFirstFrame(callback: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (!cancelled) callback();
  };
  const raf = globalThis.requestAnimationFrame as typeof requestAnimationFrame | undefined;
  if (raf) raf(() => setTimeout(run, 0));
  else setTimeout(run, 16);
  return () => {
    cancelled = true;
  };
}
