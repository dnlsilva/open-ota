import { OpenOta, OtaProvider } from "@open-ota/react-native";
import type { OtaStatus, SyncResult, UpdateState } from "@open-ota/react-native";
import * as React from "react";
import { Button, SafeAreaView, StyleSheet, Text, View } from "react-native";

export default function App() {
  const [sync, setSync] = React.useState<SyncResult | null>(null);
  return (
    <OtaProvider onSyncResult={setSync}>
      <Demo sync={sync} onSync={setSync} />
    </OtaProvider>
  );
}

function Demo({ sync, onSync }: { sync: SyncResult | null; onSync: (result: SyncResult) => void }) {
  const [status, setStatus] = React.useState<OtaStatus | null>(null);
  const [state, setState] = React.useState<UpdateState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(() => {
    OpenOta.getStatus().then(setStatus, (e: unknown) => setError(String(e)));
  }, []);

  React.useEffect(() => {
    refresh();
    const subscription = OpenOta.addListener("updateState", (next) => {
      setState(next);
      refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const check = async () => {
    setBusy(true);
    onSync(await OpenOta.sync());
    refresh();
    setBusy(false);
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>Open OTA demo</Text>

        <Row label="Release" value={status?.currentRelease ? `v${status.currentRelease.label}` : "embedded"} />
        <Row label="Pending" value={status?.pendingRelease ? `v${status.pendingRelease.label}` : "—"} />
        <Row label="Native version" value={status?.nativeVersion ?? "—"} />
        <Row label="Runtime" value={status?.runtimeVersion ?? "—"} />
        <Row label="Channel" value={status?.channel ?? "—"} />
        <Row label="Update state" value={describeState(state)} />
        <Row label="Last check" value={describeSync(sync)} />
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.buttons}>
          <Button title={busy ? "Checking…" : "Check for update"} onPress={check} disabled={busy} />
          <Button title="Reload" onPress={() => void OpenOta.reload()} />
        </View>
      </View>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function describeState(state: UpdateState | null): string {
  if (!state) return "idle";
  if (state.state === "rollback") return `rollback (${state.reason})`;
  if (state.state === "error") return `error: ${state.message}`;
  return state.state;
}

function describeSync(result: SyncResult | null): string {
  if (!result) return "—";
  switch (result.status) {
    case "upToDate":
      return "up to date";
    case "updated":
      return `got v${result.release.label}${result.reloaded ? ", reloading" : ", applies on next launch"}`;
    case "rolledBack":
      return "rolled back to embedded";
    case "pinned":
      return "pinned by a preview link";
    case "incompatible":
      return `needs native runtime ${result.runtimeVersion}`;
    case "error":
      return `error: ${result.error.message}`;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: "#111" },
  card: { backgroundColor: "#1c1c1e", borderRadius: 14, padding: 20, gap: 6 },
  title: { color: "#fff", fontSize: 20, fontWeight: "600", marginBottom: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  label: { color: "#8e8e93" },
  value: { color: "#fff", fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" },
  error: { color: "#ff453a", marginTop: 10 },
  buttons: { marginTop: 16, gap: 8 },
});
