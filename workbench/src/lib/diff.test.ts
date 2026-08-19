import { describe, expect, it } from "vitest";
import { splitFiles } from "./diff";

describe("splitFiles", () => {
  it("splits a multi-file diff on diff --git headers", () => {
    const diff = [
      "diff --git a/one.ts b/one.ts",
      "index 111..222 100644",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/two.ts b/two.ts",
      "index 333..444 100644",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d", // no trailing newline
    ].join("\n");
    const files = splitFiles(diff);
    expect(files.map((file) => file.name)).toEqual(["one.ts", "two.ts"]);
    expect(files[1]!.body.endsWith("+d")).toBe(true);
  });

  it("returns an empty list for an empty diff", () => {
    expect(splitFiles("")).toEqual([]);
    expect(splitFiles("\n")).toEqual([]);
  });

  it("handles binary patch headers", () => {
    const diff = "diff --git a/logo.png b/logo.png\nindex 111..222 100644\nBinary files a/logo.png and b/logo.png differ\n";
    const files = splitFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("logo.png");
  });

  it("handles quoted paths with spaces", () => {
    const diff = 'diff --git "a/dir with space/file.ts" "b/dir with space/file.ts"\nindex 111..222 100644\n';
    const files = splitFiles(diff);
    expect(files[0]!.name).toBe("dir with space/file.ts");
  });

  it("falls back to a placeholder name for unparsable headers", () => {
    const files = splitFiles("diff --git something unexpected\n@@ x @@\n");
    expect(files[0]!.name).toBe("(unknown file)");
  });
});
