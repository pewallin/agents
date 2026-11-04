// The ACP web view of one Codex pane. The page address names the thread (/thread/<id>) and
// carries the pane's token in its fragment (#token=...); the page connects to the agent the
// host gives this client, loads that thread and shows it. No agent or session picker: the pane
// decides what is shown.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { acpStore, loadSession } from "@acp-components/core";
import {
  AcpProvider,
  ChatView,
  I18nProvider,
  PermissionDialog,
  useAcpContext,
  useConnectionStatus,
} from "@acp-components/react";
import "@acp-components/react/styles.css";
import "./view.css";

const AGENT_ID = "codex";
const started = performance.now();
const timings: Record<string, number> = {};
(window as unknown as { __acpTimings: typeof timings }).__acpTimings = timings;
function mark(name: string) {
  if (timings[name] === undefined) timings[name] = Math.round(performance.now() - started);
}

function readToken(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  try {
    if (fromHash) sessionStorage.setItem("acp-token", fromHash);
    return fromHash ?? sessionStorage.getItem("acp-token");
  } catch {
    return fromHash;
  }
}

const sessionId = decodeURIComponent(location.pathname.match(/^\/thread\/([^/]+)/)?.[1] ?? "") || null;
const token = readToken();
// The components' colours follow data-acp-theme on the document (dark without it).
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
const applyTheme = () => {
  document.documentElement.dataset.acpTheme = darkQuery?.matches ? "dark" : "light";
};
applyTheme();
darkQuery?.addEventListener?.("change", applyTheme);
const prefersDark = darkQuery?.matches ?? false;

function Message({ text }: { text: string }) {
  return <div className="acp-view-message">{text}</div>;
}

function ThreadView({ cwd }: { cwd: string }) {
  const { getClient } = useAcpContext();
  const { status } = useConnectionStatus(AGENT_ID);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "connected" || loaded || !sessionId) return;
    mark("connected");
    const client = getClient(AGENT_ID);
    if (!client) return;
    let cancelled = false;
    // The composer finds the agent of a session through the store's workspaces; a session
    // loaded by id is not in one until it is added.
    const store = acpStore.getState();
    store.addWorkspace(cwd);
    store.setActiveWorkspace(cwd);
    store.addSession({ id: sessionId, cwd, agentId: AGENT_ID, loaded: false });
    store.setActiveSession(sessionId);
    loadSession(client, sessionId, cwd)
      .then(() => {
        if (cancelled) return;
        mark("loaded");
        setLoaded(true);
        document.title = "Codex";
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const detail = reason && typeof reason === "object" && "message" in reason
          ? String((reason as { message: unknown }).message)
          : String(reason);
        setError(detail);
      });
    return () => { cancelled = true; };
  }, [status, loaded, cwd, getClient]);

  if (!sessionId) return <Message text="This pane has no Codex thread yet." />;
  if (error) return <Message text={`Could not open the thread: ${error}`} />;
  if (status === "error" || status === "disconnected") {
    return <Message text={status === "error" ? "Could not reach Codex." : "Connecting to Codex…"} />;
  }
  if (!loaded) return <Message text="Opening the thread…" />;
  return (
    <div className="acp-view-root" data-acp-ready="true">
      <ChatView sessionId={sessionId} />
      <PermissionDialog sessionId={sessionId} />
    </div>
  );
}

function App() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch("/api/info", { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`host answered ${response.status}`)))
      .then((info: { cwd: string }) => setCwd(info.cwd))
      .catch((reason: Error) => setError(reason.message));
  }, []);

  if (!token) return <Message text="This page needs the pane's token; open it from Agents Next." />;
  if (error) return <Message text={`Could not reach the pane's ACP host: ${error}`} />;
  if (!cwd) return <Message text="Connecting to Codex…" />;
  const url = `ws://${location.host}/acp?token=${encodeURIComponent(token)}`;
  return (
    <AcpProvider
      agents={[{ id: AGENT_ID, name: "Codex", transport: { type: "websocket", url } }]}
      theme={prefersDark ? "dark" : "light"}
      defaultCwd={cwd}
    >
      <ThreadView cwd={cwd} />
    </AcpProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider defaultLocale="en">
      <App />
    </I18nProvider>
  </StrictMode>,
);
