import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PreviewLinkResponse } from "@open-ota/shared";
import { formatCountdown } from "../lib/format";
import { CopyButton } from "./CopyButton";
import { Modal } from "./Modal";

export function QrModal({
  link,
  releaseLabel,
  onClose,
  onRegenerate,
}: {
  link: PreviewLinkResponse;
  releaseLabel: string;
  onClose: () => void;
  onRegenerate?: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    // Fixed black-on-white: a themed QR would fail scanners at low contrast.
    QRCode.toDataURL(link.url, { width: 480, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => !cancelled && setDataUrl(url))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Could not render the QR code"));
    return () => {
      cancelled = true;
    };
  }, [link.url]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = formatCountdown(link.expiresAt, now);
  const expired = remaining === "expired";

  return (
    <Modal
      title={`Open ${releaseLabel} on device`}
      onClose={onClose}
      footer={
        <>
          {expired && onRegenerate ? (
            <button type="button" className="btn btn-primary" onClick={onRegenerate}>
              Generate a new link
            </button>
          ) : null}
          <CopyButton value={link.url} label="Copy link" what="Preview link copied" className="btn" />
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="error-box" role="alert">
            {error}
          </div>
        ) : (
          <div className="qr-frame">
            {dataUrl ? (
              <img src={dataUrl} alt={`QR code opening ${releaseLabel} on a device`} />
            ) : (
              <div className="skeleton" style={{ width: 240, height: 240 }} />
            )}
          </div>
        )}

        <div className={expired ? "notice tone-warning" : "notice"} aria-live="polite">
          {expired ? (
            <span>This link has expired. Generate a new one to keep testing.</span>
          ) : (
            <span>
              Expires in <b className="num">{remaining}</b>. Scan with a phone that already has the app
              installed — the SDK verifies the signature and pins the release until{" "}
              <code>exitPreview()</code>.
            </span>
          )}
        </div>

        <div className="link-box">
          <span title={link.url}>{link.url}</span>
        </div>

        <p className="hint">
          The link opens <code>{link.scheme}://ota/preview</code>. A build whose runtime version does not
          match this release will refuse it with an explanation on the device.
        </p>
      </div>
    </Modal>
  );
}
