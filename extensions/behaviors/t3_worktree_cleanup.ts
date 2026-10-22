import { z } from "npm:zod@4";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const GIT_BEHAVIOR_NAME = "t3-worktree-git";
const MAX_REMOVALS_PER_RUN = 90; // runModel allows 100 nested calls per execution

const GlobalArgsSchema = z.object({
  stateDbPath: z.string().optional().describe(
    "Path to the T3 Code state database (default: ~/.t3/userdata/statev2.sqlite)",
  ),
  worktreesRoot: z.string().optional().describe(
    "Directory holding T3 worktrees as <project>/<worktree> (default: ~/.t3/worktrees)",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ScanArgsSchema = z.object({
  inactiveDays: z.number().min(0).default(4).describe(
    "Minimum number of days without thread or code activity",
  ),
});

const PruneArgsSchema = z.object({
  exclude: z.array(z.string()).default([]).describe(
    "Worktree paths or names to keep even though the scan lists them",
  ),
  dryRun: z.boolean().default(false).describe(
    "Report what would be removed without changing anything",
  ),
});

const UnsettledThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
});

const WorktreeSchema = z.object({
  path: z.string(),
  project: z.string(),
  name: z.string(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  isGitWorktree: z.boolean(),
  orphan: z.boolean(),
  threadCount: z.number(),
  topLevelThreadCount: z.number(),
  unsettledThreads: z.array(UnsettledThreadSchema),
  lastThreadActivityAt: z.string().nullable(),
  lastCodeActivityAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  idleDays: z.number().nullable(),
  dirty: z.boolean(),
  dirtyFileCount: z.number(),
  eligible: z.boolean(),
  deletable: z.boolean(),
  reasons: z.array(z.string()),
});
type Worktree = z.infer<typeof WorktreeSchema>;

const ScanSchema = z.object({
  scannedAt: z.string(),
  inactiveDays: z.number(),
  cutoff: z.string(),
  stateDbPath: z.string(),
  worktreesRoot: z.string(),
  worktrees: z.array(WorktreeSchema),
  candidates: z.array(z.string()),
  dirtyCandidates: z.array(z.string()),
});
type Scan = z.infer<typeof ScanSchema>;

const RemovalResultSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  status: z.enum(["removed", "planned", "skipped", "failed"]),
  worktreeRemoved: z.boolean(),
  branchDeleted: z.boolean(),
  message: z.string(),
});
type RemovalResult = z.infer<typeof RemovalResultSchema>;

const RemovalSchema = z.object({
  removedAt: z.string(),
  scannedAt: z.string(),
  dryRun: z.boolean(),
  removedCount: z.number(),
  plannedCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  results: z.array(RemovalResultSchema),
});

type Logger = {
  info(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
};

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type ThreadRecord = {
  id: string;
  title: string;
  worktreePath: string;
  isTopLevel: boolean;
  settled: boolean;
  updatedAt: string;
};

type GitInfo = {
  repoPath: string;
  branch: string | null;
  dirtyFileCount: number;
  lastCodeActivityMs: number | null;
};

function resolvePaths(globalArgs: GlobalArgs) {
  const home = Deno.env.get("HOME");
  if (!home && (!globalArgs.stateDbPath || !globalArgs.worktreesRoot)) {
    throw new Error("HOME is not set; configure stateDbPath and worktreesRoot");
  }
  return {
    stateDbPath: globalArgs.stateDbPath ??
      join(home!, ".t3", "userdata", "statev2.sqlite"),
    worktreesRoot: (globalArgs.worktreesRoot ?? join(home!, ".t3", "worktrees"))
      .replace(/\/+$/, ""),
  };
}

/** Reads non-deleted T3 threads that point at a worktree, without writing to the database. */
function readThreads(stateDbPath: string): ThreadRecord[] {
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT payload_json FROM orchestration_v2_projection_threads
       WHERE deleted_at IS NULL`,
    ).all() as Array<{ payload_json: string }>;
    const threads: ThreadRecord[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      if (!payload.worktreePath || payload.deletedAt) continue;
      threads.push({
        id: payload.id,
        title: payload.title ?? "",
        worktreePath: String(payload.worktreePath).replace(/\/+$/, ""),
        isTopLevel: !payload.lineage?.parentThreadId,
        // Archived threads are done from the user's point of view.
        settled: payload.settledOverride === "settled" ||
          payload.archivedAt != null,
        updatedAt: payload.updatedAt,
      });
    }
    return threads;
  } finally {
    db.close();
  }
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args: ["--no-optional-locks", "-C", cwd, ...args],
    // Keep git from refreshing the index, which would count as our own activity.
    env: { GIT_OPTIONAL_LOCKS: "0" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    ok: out.success,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr).trim(),
  };
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await Deno.lstat(path)).mtime?.getTime() ?? null;
  } catch {
    return null;
  }
}

function maxOf(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
}

/** Returns git details for a linked worktree, or null if the path is not one. */
async function inspectGit(path: string): Promise<GitInfo | null> {
  const revParse = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  if (!revParse.ok) return null;
  const [gitDir, commonDir, topLevel] = revParse.stdout.trim().split("\n");
  const realPath = await Deno.realPath(path);
  if (gitDir === commonDir || topLevel !== realPath) return null;

  const repoPath = basename(commonDir) === ".git"
    ? dirname(commonDir)
    : commonDir;
  const branch = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const lastCommit = await git(path, ["log", "-1", "--format=%cI"]);
  const status = await git(path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.ok) throw new Error(`git status failed in ${path}: ${status.stderr}`);

  const dirtyPaths: string[] = [];
  const tokens = status.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    dirtyPaths.push(entry.slice(3));
    // Renames and copies are followed by the original path.
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  const fileTimes = await Promise.all(
    dirtyPaths.map((p) => mtimeMs(join(path, p))),
  );

  return {
    repoPath,
    branch: branch.ok ? branch.stdout.trim() : null,
    dirtyFileCount: dirtyPaths.length,
    lastCodeActivityMs: maxOf([
      lastCommit.ok && lastCommit.stdout.trim()
        ? Date.parse(lastCommit.stdout.trim())
        : null,
      // Moves of HEAD (commit, checkout, rebase, reset) touch the worktree's reflog.
      await mtimeMs(join(gitDir, "logs", "HEAD")),
      ...fileTimes,
    ]),
  };
}

async function listWorktreeDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for await (const project of Deno.readDir(root)) {
    if (!project.isDirectory) continue;
    for await (const entry of Deno.readDir(join(root, project.name))) {
      if (entry.isDirectory) dirs.push(join(root, project.name, entry.name));
    }
  }
  return dirs.sort();
}

const toIso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();

async function analyze(globalArgs: GlobalArgs, inactiveDays: number): Promise<Scan> {
  const { stateDbPath, worktreesRoot } = resolvePaths(globalArgs);
  const now = Date.now();
  const cutoffMs = now - inactiveDays * DAY_MS;

  const threadsByPath = new Map<string, ThreadRecord[]>();
  for (const thread of readThreads(stateDbPath)) {
    const list = threadsByPath.get(thread.worktreePath) ?? [];
    list.push(thread);
    threadsByPath.set(thread.worktreePath, list);
  }

  const worktrees: Worktree[] = [];
  for (const path of await listWorktreeDirs(worktreesRoot)) {
    const threads = threadsByPath.get(path) ?? [];
    const topLevel = threads.filter((t) => t.isTopLevel);
    // Child (subagent) threads don't decide settlement, but their activity counts.
    const unsettled = topLevel.filter((t) => !t.settled);
    const lastThreadMs = maxOf(threads.map((t) => Date.parse(t.updatedAt)));
    const gitInfo = await inspectGit(path);
    const lastCodeMs = gitInfo
      ? gitInfo.lastCodeActivityMs
      : await mtimeMs(path);
    const lastActivityMs = maxOf([lastThreadMs, lastCodeMs]);

    const reasons: string[] = [];
    if (!gitInfo) reasons.push("not a linked git worktree");
    if (unsettled.length) {
      reasons.push(`${unsettled.length} unsettled thread(s)`);
    }
    if (lastActivityMs === null || lastActivityMs >= cutoffMs) {
      reasons.push(`activity within the last ${inactiveDays} day(s)`);
    }
    const eligible = reasons.length === 0;
    const dirty = (gitInfo?.dirtyFileCount ?? 0) > 0;
    if (eligible && dirty) reasons.push("uncommitted changes; never deleted");

    worktrees.push({
      path,
      project: basename(dirname(path)),
      name: basename(path),
      repoPath: gitInfo?.repoPath ?? null,
      branch: gitInfo?.branch ?? null,
      isGitWorktree: gitInfo !== null,
      orphan: threads.length === 0,
      threadCount: threads.length,
      topLevelThreadCount: topLevel.length,
      unsettledThreads: unsettled.map((t) => ({ id: t.id, title: t.title })),
      lastThreadActivityAt: toIso(lastThreadMs),
      lastCodeActivityAt: toIso(lastCodeMs),
      lastActivityAt: toIso(lastActivityMs),
      idleDays: lastActivityMs === null
        ? null
        : Math.floor((now - lastActivityMs) / DAY_MS),
      dirty,
      dirtyFileCount: gitInfo?.dirtyFileCount ?? 0,
      eligible,
      deletable: eligible && !dirty,
      reasons,
    });
  }

  return {
    scannedAt: new Date(now).toISOString(),
    inactiveDays,
    cutoff: new Date(cutoffMs).toISOString(),
    stateDbPath,
    worktreesRoot,
    worktrees,
    candidates: worktrees.filter((w) => w.deletable).map((w) => w.path),
    dirtyCandidates: worktrees.filter((w) => w.eligible && w.dirty).map((w) =>
      w.path
    ),
  };
}

function describeWorktree(w: Worktree): string {
  const origin = w.orphan ? "no threads" : `${w.threadCount} thread(s)`;
  return `${w.project}/${w.name} [${w.branch ?? "detached"}] idle ${w.idleDays}d, ${origin}`;
}

export const behavior = {
  type: "@remshams/t3-worktree-cleanup",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    scan: {
      description: "T3 worktrees with their settlement, activity, and cleanup eligibility",
      schema: ScanSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    removal: {
      description: "Outcome of removing the worktrees selected by the latest scan",
      schema: RemovalSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    scan: {
      description:
        "List T3 worktrees whose top-level threads are all settled and that had no thread or code activity for inactiveDays",
      arguments: ScanArgsSchema,
      execute: async (
        args: z.infer<typeof ScanArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: Logger;
          writeResource: WriteResource;
        },
      ) => {
        const scan = await analyze(context.globalArgs, args.inactiveDays);
        const eligible = scan.worktrees.filter((w) => w.eligible);

        context.logger.info(
          "{eligible} of {total} worktrees idle for {days}+ days with all threads settled",
          {
            eligible: eligible.length,
            total: scan.worktrees.length,
            days: scan.inactiveDays,
          },
        );
        for (const w of eligible) {
          const line = describeWorktree(w);
          if (w.dirty) {
            context.logger.warning("KEEP (dirty, {count} files) {line}", {
              count: w.dirtyFileCount,
              line,
            });
          } else {
            context.logger.info("DELETE {line}", { line });
          }
        }

        const handle = await context.writeResource("scan", "scan", scan);
        return { dataHandles: [handle] };
      },
    },
    // Not named remove/delete: swamp treats those names as lifecycle deletes and tombstones the behavior's data.
    prune: {
      description:
        "Remove the deletable worktrees from the latest scan after re-checking each one, then delete their merged or pushed local branches",
      arguments: PruneArgsSchema,
      execute: async (
        args: z.infer<typeof PruneArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: Logger;
          writeResource: WriteResource;
          readResource: (
            instanceName: string,
          ) => Promise<Record<string, unknown> | null>;
          runModel: (options: {
            modelType: string;
            name: string;
            method: string;
            arguments: Record<string, unknown>;
          }) => Promise<
            | {
              ok: true;
              resources: Array<{ attributes?: Record<string, unknown> }>;
            }
            | { ok: false; error: { message: string } }
          >;
        },
      ) => {
        const previous = await context.readResource("scan") as Scan | null;
        if (!previous) throw new Error("No scan data found; run the scan method first");

        // Re-check against current state: threads or code may have changed since the scan.
        const fresh = await analyze(context.globalArgs, previous.inactiveDays);
        const freshByPath = new Map(fresh.worktrees.map((w) => [w.path, w]));
        const excluded = new Set(args.exclude);

        const results: RemovalResult[] = [];
        let removalsStarted = 0;
        for (const path of previous.candidates) {
          const current = freshByPath.get(path);
          const skip = (message: string) =>
            results.push({
              path,
              branch: current?.branch ?? null,
              status: "skipped",
              worktreeRemoved: false,
              branchDeleted: false,
              message,
            });

          if (excluded.has(path) || excluded.has(basename(path))) {
            skip("excluded");
            continue;
          }
          if (!current) {
            skip("no longer on disk");
            continue;
          }
          if (!current.deletable || !current.repoPath) {
            skip(`no longer deletable: ${current.reasons.join("; ")}`);
            continue;
          }
          if (removalsStarted >= MAX_REMOVALS_PER_RUN) {
            skip("per-run removal limit reached; run the workflow again");
            continue;
          }
          removalsStarted++;
          if (args.dryRun) {
            results.push({
              path,
              branch: current.branch,
              status: "planned",
              worktreeRemoved: false,
              branchDeleted: false,
              message: "dry run; would remove the worktree",
            });
            continue;
          }

          const removal = await context.runModel({
            modelType: "@swamp/git",
            name: GIT_BEHAVIOR_NAME,
            method: "remove_worktree",
            arguments: { repoPath: current.repoPath, path },
          });
          const removed = removal.ok &&
            removal.resources.some((r) => r.attributes?.removed === true);
          if (!removed) {
            const message = removal.ok
              ? "git did not remove the worktree"
              : removal.error.message;
            context.logger.warning("Failed to remove {path}: {message}", {
              path,
              message,
            });
            results.push({
              path,
              branch: current.branch,
              status: "failed",
              worktreeRemoved: false,
              branchDeleted: false,
              message,
            });
            continue;
          }

          let branchDeleted = false;
          let message = "worktree removed";
          if (current.branch) {
            // `-d` only deletes branches merged into HEAD or pushed to their upstream.
            const branch = await git(current.repoPath, [
              "branch",
              "-d",
              "--",
              current.branch,
            ]);
            branchDeleted = branch.ok;
            message = branch.ok
              ? `worktree and branch ${current.branch} removed`
              : `worktree removed; kept branch ${current.branch}: ${branch.stderr}`;
          }
          context.logger.info("{path}: {message}", { path, message });
          results.push({
            path,
            branch: current.branch,
            status: "removed",
            worktreeRemoved: true,
            branchDeleted,
            message,
          });
        }

        const count = (status: RemovalResult["status"]) =>
          results.filter((r) => r.status === status).length;
        const handle = await context.writeResource("removal", "removal", {
          removedAt: new Date().toISOString(),
          scannedAt: previous.scannedAt,
          dryRun: args.dryRun,
          removedCount: count("removed"),
          plannedCount: count("planned"),
          skippedCount: count("skipped"),
          failedCount: count("failed"),
          results,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
