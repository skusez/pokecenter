import { BunServices } from "@effect/platform-bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Redacted } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentConfig } from "../src/AgentConfig.ts"
import { branchFor, type Worktree, Worktrees } from "../src/Worktrees.ts"

// Local repos only: the "remote" is a bare repo on disk.
const root = realpathSync(mkdtempSync(join(tmpdir(), "pokecenter-worktrees-")))
const remote = join(root, "remote.git")
const repo = join(root, "repo")
const worktreeRoot = join(root, "worktrees")
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" }).toString().trim()

beforeAll(() => {
  git(root, "init", "-q", "--bare", "-b", "main", remote)
  git(root, "clone", "-q", remote, repo)
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  git(repo, "push", "-q", "origin", "main")
  // Unpushed local work on main must not leak into a report's branch.
  git(repo, "commit", "-q", "--allow-empty", "-m", "half-finished")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const layer = Worktrees.layer.pipe(
  Layer.provide(
    Layer.merge(
      Layer.succeed(AgentConfig, {
        url: "http://127.0.0.1:1",
        token: Redacted.make("t"),
        repos: { byName: {}, fallback: undefined, entries: [] },
        digestModel: Option.none(),
        investigateModel: Option.none(),
        maxInvestigationsPerRun: 1,
        worktreeRoot,
        opencodeBin: "opencode",
        stateDir: root
      }),
      BunServices.layer
    )
  ),
  Layer.provideMerge(BunServices.layer)
)

const withWorktree = <A>(shortId: string, use: (worktree: Worktree) => A) =>
  Effect.scoped(
    Effect.gen(function*() {
      const worktrees = yield* Worktrees
      const worktree = yield* worktrees.acquire(repo, shortId)
      return use(worktree)
    })
  ).pipe(Effect.provide(layer), Effect.runPromise)

test("branchFor uses the short id, stripped to safe characters", () => {
  expect(branchFor("AB-12/x")).toEqual({ slug: "AB12x", branch: "inbox/AB12x" })
})

describe("Worktrees.acquire", () => {
  test("branches from origin/main, installs the opencode config, and excludes it", async () => {
    const seen = await withWorktree("AA1", (wt) => ({
      ...wt,
      head: git(wt.dir, "rev-parse", "HEAD"),
      branchName: git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD"),
      config: JSON.parse(readFileSync(join(wt.dir, ".opencode", "opencode.json"), "utf8")),
      status: git(wt.dir, "status", "--porcelain")
    }))
    expect(seen.dir).toBe(join(worktreeRoot, "AA1"))
    expect(seen.branchName).toBe("inbox/AA1")
    expect(seen.head).toBe(git(repo, "rev-parse", "origin/main"))
    expect(seen.head).not.toBe(git(repo, "rev-parse", "HEAD"))
    expect(Object.keys(seen.config.agents)).toEqual(["digest", "investigate"])
    expect(seen.config.mcp).toBeUndefined()
    expect(seen.status).toBe("")
    // Nothing committed: gone once the scope closes.
    expect(existsSync(seen.dir)).toBe(false)
    expect(git(repo, "branch", "--list", "inbox/AA1")).toBe("")
  })

  test("keeps a worktree that holds commits", async () => {
    const dir = await withWorktree("BB2", (wt) => {
      git(wt.dir, "commit", "-q", "--allow-empty", "-m", "fix")
      return wt.dir
    })
    expect(existsSync(dir)).toBe(true)
    expect(git(repo, "branch", "--list", "inbox/BB2")).toContain("inbox/BB2")
  })

  test("a retry replaces a leftover worktree and branch", async () => {
    const head = await withWorktree("BB2", (wt) => git(wt.dir, "rev-parse", "HEAD"))
    expect(head).toBe(git(repo, "rev-parse", "origin/main"))
  })

  test("a report with a pushed branch continues it", async () => {
    await withWorktree("CC3", (wt) => {
      git(wt.dir, "commit", "-q", "--allow-empty", "-m", "first pass")
      git(wt.dir, "push", "-q", "origin", "inbox/CC3")
    })
    const pushed = git(repo, "rev-parse", "origin/inbox/CC3")
    const seen = await withWorktree("CC3", (wt) => ({ base: wt.base, head: git(wt.dir, "rev-parse", "HEAD") }))
    expect(seen.base).toBe(pushed)
    expect(seen.head).toBe(pushed)
  })
})
