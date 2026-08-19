/** Bounded client-side log buffer: pure logic, unit-tested. */

export interface LogBufferState {
  /** Raw buffered text (never split mid-line at append time). */
  text: string;
  /** Byte offset for the next server read. */
  nextOffset: number;
  /** Server signalled the read cursor reached end of file. */
  complete: boolean;
  droppedBytes: number;
  droppedLines: number;
}

export const MAX_BUFFER_BYTES = 512 * 1024;
export const MAX_LINES = 5000;

export function emptyLogBuffer(): LogBufferState {
  return { text: "", nextOffset: 0, complete: false, droppedBytes: 0, droppedLines: 0 };
}

/**
 * Appends one server chunk. Out-of-order or duplicate chunks (offset mismatch)
 * are ignored so a stale fetch can never corrupt the buffer. The buffer is
 * bounded by dropping whole lines from the head; a single line longer than the
 * cap is cut by raw head bytes.
 */
export function appendChunk(state: LogBufferState, chunk: { offset: number; nextOffset: number; data: string; complete: boolean }): LogBufferState {
  if (chunk.offset !== state.nextOffset) return state;
  let text = state.text + chunk.data;
  let { droppedBytes, droppedLines } = state;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    const dropped = lines.splice(0, lines.length - MAX_LINES);
    droppedLines += dropped.length;
    droppedBytes += dropped.reduce((sum, line) => sum + line.length + 1, 0);
    text = lines.join("\n");
  }
  while (text.length > MAX_BUFFER_BYTES) {
    const newline = text.indexOf("\n");
    if (newline < 0 || newline === text.length - 1) {
      const excess = text.length - MAX_BUFFER_BYTES;
      droppedBytes += excess;
      text = text.slice(excess);
      break;
    }
    droppedBytes += newline + 1;
    droppedLines += 1;
    text = text.slice(newline + 1);
  }
  return { text, nextOffset: chunk.nextOffset, complete: chunk.complete, droppedBytes, droppedLines };
}

/** Line splitting happens once per render — chunk boundaries never matter. */
export function linesOf(state: LogBufferState): string[] {
  return state.text === "" ? [] : state.text.split("\n");
}
