import { useEffect, useState } from "react";
import { clearToken, initToken, onUnauthorized, setToken } from "./api";
import { connectActivity } from "./sse";
import { TaskListView } from "./views/TaskListView";
import { RunDetailView } from "./views/RunDetailView";

type View = { kind: "list" } | { kind: "run"; taskId: string };

/** The URL is the view contract: /tasks/:id is the run detail, / the list. A
 *  refresh during an active run rebuilds identical state from the API. */
function viewFromLocation(): View {
  const match = /^\/tasks\/([0-9a-f-]{36})$/.exec(window.location.pathname);
  return match !== null ? { kind: "run", taskId: match[1]! } : { kind: "list" };
}

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="token-gate">
      <h1>AgentDock Workbench</h1>
      <p>Enter the gateway access token — find it in <code>.agentdock/gateway-token</code> or the <code>agentdock serve</code> startup log.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() !== "") onSubmit(value.trim());
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="gateway token"
          autoFocus
        />
        <button type="submit">Connect</button>
      </form>
    </div>
  );
}

export function App() {
  const [token, setTokenState] = useState<string | null>(() => initToken());
  const [view, setView] = useState<View>(() => viewFromLocation());
  // Ticks are invalidation signals: SSE events trigger refetches, never patches.
  const [listTick, setListTick] = useState(0);
  const [runTick, setRunTick] = useState(0);

  const navigate = (next: View): void => {
    window.history.pushState(null, "", next.kind === "run" ? `/tasks/${next.taskId}` : "/");
    setView(next);
  };

  useEffect(() => {
    const onPop = () => setView(viewFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    onUnauthorized(() => setTokenState(null));
  }, []);

  useEffect(() => {
    if (token === null) return;
    return connectActivity(
      (event) => {
        // Every event for the open task may affect any detail section (diff,
        // artifacts, activity timeline), not just the header: both views refresh.
        if (event.type.startsWith("task.")) setListTick((tick) => tick + 1);
        if (/^(run|step|approval|review|verify|artifact)\./.test(event.type)) setListTick((tick) => tick + 1);
        setRunTick((tick) => tick + 1);
      },
      () => {
        setListTick((tick) => tick + 1);
        setRunTick((tick) => tick + 1);
      },
    );
  }, [token]);

  if (token === null) {
    return (
      <TokenGate
        onSubmit={(value) => {
          setToken(value);
          setTokenState(value);
        }}
      />
    );
  }
  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate({ kind: "list" })}>AgentDock</button>
        <span className="live" title="live via SSE">● live</span>
        <button
          className="link"
          onClick={() => {
            clearToken();
            setTokenState(null);
          }}
        >
          sign out
        </button>
      </header>
      {view.kind === "list"
        ? <TaskListView tick={listTick} onOpen={(taskId) => navigate({ kind: "run", taskId })} />
        : <RunDetailView taskId={view.taskId} tick={runTick} onBack={() => navigate({ kind: "list" })} />}
    </div>
  );
}
