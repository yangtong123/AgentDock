import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../api";
import type { LogChunk } from "../types";
import { appendChunk, emptyLogBuffer, linesOf, type LogBufferState } from "../lib/log-buffer";

const ROW_HEIGHT = 18;
const OVERSCAN = 8;

/**
 * Live step log: byte-offset polling against the log endpoint with a bounded
 * client buffer (head-drop with dropped-line accounting) and a hand-rolled
 * fixed-row-height virtualizer. Finished logs are paged to completion in 64
 * KiB chunks; a request generation counter keeps stale resolves out.
 */
export function LogPane({ stepRunId, running }: { stepRunId: string; running: boolean }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [buffer, setBuffer] = useState<LogBufferState>(emptyLogBuffer);
  const bufferRef = useRef(buffer);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const generation = ++generationRef.current;
    bufferRef.current = emptyLogBuffer();
    setBuffer(bufferRef.current);
    pendingRef.current = false;
    let cancelled = false;

    const poll = (): void => {
      // Never double-fetch the same offset: one in-flight request at a time.
      if (cancelled || pendingRef.current) return;
      pendingRef.current = true;
      apiGet<LogChunk>(`/steps/${stepRunId}/log?offset=${bufferRef.current.nextOffset}&limit=65536&stream=${stream}`)
        .then((chunk) => {
          if (cancelled || generation !== generationRef.current) return; // stale stream/step
          bufferRef.current = appendChunk(bufferRef.current, chunk);
          setBuffer(bufferRef.current);
          // Page through a long finished log without waiting for the interval.
          if (!chunk.complete && chunk.data !== "") setTimeout(poll, 0);
        })
        .catch(() => undefined)
        .finally(() => { pendingRef.current = false; });
    };

    poll();
    const timer = running ? setInterval(poll, 1000) : null;
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [stepRunId, stream, running]);

  // Track viewport size for the virtualizer.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(() => setViewportHeight(container.clientHeight));
    observer.observe(container);
    setViewportHeight(container.clientHeight);
    return () => observer.disconnect();
  }, []);

  const lines = useMemo(() => linesOf(buffer), [buffer]);

  // Keep pinned to the tail while new output arrives, unless the user scrolled up.
  useEffect(() => {
    const container = containerRef.current;
    if (container !== null && stickToBottom.current) container.scrollTop = container.scrollHeight;
  }, [lines]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(lines.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div className="log-pane">
      <div className="log-toolbar">
        <div className="tabs">
          <button className={stream === "stdout" ? "tab selected" : "tab"} onClick={() => setStream("stdout")}>stdout</button>
          <button className={stream === "stderr" ? "tab selected" : "tab"} onClick={() => setStream("stderr")}>stderr</button>
        </div>
        <span className="small dim">
          {running ? "live · 1s poll" : buffer.complete ? "complete" : "static"}
          {buffer.droppedLines > 0 || buffer.droppedBytes > 0
            ? ` · showing latest ${lines.length} lines (dropped ${buffer.droppedLines} lines / ${(buffer.droppedBytes / 1024).toFixed(0)} KiB)`
            : ""}
        </span>
      </div>
      <div
        className="log-scroll mono"
        ref={containerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          setScrollTop(element.scrollTop);
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT * 3;
        }}
      >
        <div style={{ height: lines.length * ROW_HEIGHT, position: "relative", width: "max-content", minWidth: "100%" }}>
          {lines.slice(startIndex, endIndex).map((line, index) => (
            <div key={startIndex + index} className="log-line" style={{ top: (startIndex + index) * ROW_HEIGHT }}>
              <span className="log-number">{startIndex + index + 1}</span>{line}
            </div>
          ))}
        </div>
        {lines.length === 0 && <div className="dim log-empty">no output yet</div>}
      </div>
    </div>
  );
}
