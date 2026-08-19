/** Splits a unified diff into per-file sections on `diff --git` headers. Pure, unit-tested. */

export interface FileDiff {
  name: string;
  body: string;
}

export function splitFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (part.trim() === "") continue;
    // Quoted paths (spaces/special chars) come as: diff --git "a/x y" "b/x y"
    const quoted = /^diff --git "(?:a\/)?(?:[^"\\]|\\.)+" "(?:b\/)?((?:[^"\\]|\\.)+)"$/m.exec(part);
    const plain = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const binary = /^Binary files a\/(.+?) and b\/(.+?) differ$/m.exec(part);
    const name = quoted?.[1] ?? plain?.[2] ?? binary?.[2] ?? "(unknown file)";
    files.push({ name, body: part });
  }
  return files;
}
