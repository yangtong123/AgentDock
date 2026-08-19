import { describe, expect, it } from "vitest";
import { appendChunk, emptyLogBuffer, linesOf, MAX_BUFFER_BYTES, MAX_LINES } from "./log-buffer";

function chunk(offset: number, data: string, complete = false) {
  return { offset, nextOffset: offset + data.length, data, complete };
}

describe("appendChunk", () => {
  it("appends in-order chunks", () => {
    let state = emptyLogBuffer();
    state = appendChunk(state, chunk(0, "hello\n"));
    state = appendChunk(state, chunk(6, "world\n", true));
    expect(linesOf(state)).toEqual(["hello", "world", ""]);
    expect(state.complete).toBe(true);
    expect(state.nextOffset).toBe(12);
  });

  it("ignores duplicate and out-of-order chunks", () => {
    let state = emptyLogBuffer();
    state = appendChunk(state, chunk(0, "a\n"));
    const dup = appendChunk(state, chunk(0, "a\n"));
    expect(dup.text).toBe("a\n");
    const future = appendChunk(state, chunk(10, "b\n"));
    expect(future.text).toBe("a\n");
  });

  it("does not produce phantom lines at \\n boundaries", () => {
    let state = emptyLogBuffer();
    state = appendChunk(state, chunk(0, "first\n"));
    state = appendChunk(state, chunk(6, "\nsecond"));
    expect(linesOf(state)).toEqual(["first", "", "second"]);
  });

  it("handles a chunk ending mid-line", () => {
    let state = emptyLogBuffer();
    state = appendChunk(state, chunk(0, "par"));
    state = appendChunk(state, chunk(3, "tial\nrest"));
    expect(linesOf(state)).toEqual(["partial", "rest"]);
  });

  it("drops whole lines from the head beyond MAX_LINES and tracks them", () => {
    let state = emptyLogBuffer();
    const big = Array.from({ length: MAX_LINES + 100 }, (_, index) => `line${index}`).join("\n") + "\n";
    state = appendChunk(state, chunk(0, big, true));
    const lines = linesOf(state);
    expect(lines.length).toBe(MAX_LINES); // 4999 lines + trailing empty
    expect(lines[0]).toBe(`line101`);
    expect(state.droppedLines).toBe(101);
    // Each dropped line contributes its length plus its "\n" separator.
    expect(state.droppedBytes).toBe(Array.from({ length: 101 }, (_, i) => `line${i}`).join("\n").length + 1);
  });

  it("cuts a single oversized line by raw head bytes", () => {
    let state = emptyLogBuffer();
    state = appendChunk(state, chunk(0, "x".repeat(MAX_BUFFER_BYTES + 10), true));
    expect(state.text.length).toBe(MAX_BUFFER_BYTES);
    expect(state.droppedBytes).toBe(10);
    expect(state.droppedLines).toBe(0);
  });
});
