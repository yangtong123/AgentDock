import { useEffect, useState } from "react";
import { apiGet } from "../api";
import type { DiffResult } from "../types";
import { splitFiles } from "../lib/diff";

const MAX_DIFF_BYTES = 256 * 1024;

/** Capped diff per file; files collapsible; truncation is surfaced, never silent. */
export function DiffView({ taskId, tick }: { taskId: string; tick: number }) {
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<DiffResult>(`/tasks/${taskId}/diff?maxBytes=${MAX_DIFF_BYTES}`)
      .then(setResult)
      .catch((err: Error) => setError(err.message));
  }, [taskId, tick]);

  if (error !== null) return <p className="error">{error}</p>;
  if (result === null) return <p className="dim">loading diff…</p>;
  if (result.diff.trim() === "") return <p className="dim">No changes.</p>;
  const files = splitFiles(result.diff);
  return (
    <div className="diff-view">
      {result.truncated && (
        <p className="badge attention">
          diff truncated: showing {(MAX_DIFF_BYTES / 1024).toFixed(0)} KiB of {(result.totalBytes / 1024).toFixed(0)} KiB
        </p>
      )}
      {files.map((file) => (
        <details key={file.name} className="diff-file" open={files.length <= 3}>
          <summary className="mono">{file.name}</summary>
          <pre className="mono diff-body">{file.body}</pre>
        </details>
      ))}
    </div>
  );
}
