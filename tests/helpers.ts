import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createRepository(directory: string): string {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init"], { cwd: directory });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "agentdock@test"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "AgentDock Test"], { cwd: directory });
  writeFileSync(join(directory, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: directory });
  return directory;
}
