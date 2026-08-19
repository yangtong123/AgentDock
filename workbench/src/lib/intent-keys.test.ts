import { describe, expect, it } from "vitest";
import { IntentKeys } from "./intent-keys";

describe("IntentKeys", () => {
  it("mints a UUID key on first begin", () => {
    const keys = new IntentKeys();
    const key = keys.begin();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("blocks a second begin while in flight (double-click guard)", () => {
    const keys = new IntentKeys();
    keys.begin();
    expect(keys.begin()).toBeNull();
  });

  it("reuses the key across failures of the same intent", () => {
    const keys = new IntentKeys();
    const first = keys.begin()!;
    keys.fail();
    expect(keys.begin()).toBe(first);
    keys.fail();
    expect(keys.begin()).toBe(first);
  });

  it("rotates the key after success", () => {
    const keys = new IntentKeys();
    const first = keys.begin()!;
    keys.settle();
    const second = keys.begin()!;
    expect(second).not.toBe(first);
  });

  it("rotates the key after explicit reset", () => {
    const keys = new IntentKeys();
    const first = keys.begin()!;
    keys.reset();
    expect(keys.begin()).not.toBe(first);
  });
});
