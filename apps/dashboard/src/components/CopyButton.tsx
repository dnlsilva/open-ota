import { useToast } from "./Toast";

export function CopyButton({
  value,
  label = "Copy",
  what = "Copied to clipboard",
  className = "btn btn-sm",
}: {
  value: string;
  label?: string;
  what?: string;
  className?: string;
}) {
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        // navigator.clipboard is undefined on insecure origins, so it is probed
        // rather than called — a self-hosted server on plain http is normal.
        const write = navigator.clipboard?.writeText(value);
        if (!write) {
          toast("Clipboard needs a secure (https) origin — copy manually", "critical");
          return;
        }
        void write.then(() => toast(what, "healthy")).catch(() => toast("Could not copy", "critical"));
      }}
    >
      {label}
    </button>
  );
}

/** Monospace value with a copy affordance — app keys, tokens, public keys. */
export function CopyRow({ value, what, multiline }: { value: string; what?: string; multiline?: boolean }) {
  return (
    <div className="row" style={{ alignItems: multiline ? "flex-start" : "center" }}>
      <div className="link-box" style={multiline ? { flex: 1, whiteSpace: "pre-wrap" } : { flex: 1 }}>
        {multiline ? (
          <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "auto", maxHeight: 160 }}>
            {value}
          </span>
        ) : (
          <span title={value}>{value}</span>
        )}
      </div>
      <CopyButton value={value} what={what} />
    </div>
  );
}
