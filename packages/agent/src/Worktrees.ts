import { Context, Effect, FileSystem, Layer, Path, type PlatformError, type Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { AgentConfig } from "./AgentConfig.ts"
import type { GitFailed } from "./Errors.ts"
import { git } from "./Exec.ts"
import * as OpencodeConfig from "./OpencodeConfig.ts"

export interface Worktree {
  readonly dir: string
  readonly branch: string
  /** The commit the branch started from. */
  readonly base: string
}

/** The branch a report's work lives on. The short id, never a slice of the Message-Id. */
export const branchFor = (shortId: string): { slug: string; branch: string } => {
  // A Message-Id slice is shared by every message forwarded through one
  // domain ("…ample.com"), and one shared slug meant one shared branch for
  // every report. The short id is the report's own.
  const slug = shortId.replace(/[^A-Za-z0-9]/g, "")
  return { slug, branch: `inbox/${slug}` }
}

export class Worktrees extends Context.Service<Worktrees, {
  /**
   * A scratch worktree of `repo` on the report's branch. Closing the scope
   * removes it again unless the agent committed something worth looking at.
   */
  acquire(repo: string, shortId: string): Effect.Effect<Worktree, GitFailed | PlatformError.PlatformError, Scope.Scope>
}>()("@skusez/pokecenter-agent/Worktrees") {
  static readonly layer = Layer.effect(
    Worktrees,
    Effect.gen(function*() {
      const { worktreeRoot } = yield* AgentConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>()

      /**
       * Isolation is created here rather than by the agent, so it holds whether
       * or not the model thinks to ask for it. The agent never sees the primary
       * checkout, so a run cannot leave the real working tree dirty.
       */
      const create = Effect.fn("Worktrees.create")(function*(repo: string, shortId: string) {
        const { slug, branch } = branchFor(shortId)
        const dir = path.join(worktreeRoot, slug)

        yield* fs.makeDirectory(worktreeRoot, { recursive: true })
        yield* git(repo, ["worktree", "prune"])

        // A run that died mid-flight leaves the branch behind, and `worktree
        // add` then refuses forever: one crash would block every retry of that
        // report.
        yield* Effect.ignore(git(repo, ["worktree", "remove", "--force", dir]))
        yield* Effect.ignore(git(repo, ["branch", "-D", branch]))

        // Branch from the remote tip, not the local checkout: whatever the
        // owner has half-finished on main must not end up inside the PR.
        yield* Effect.ignore(git(repo, ["fetch", "origin", "main", "--quiet"]))
        // A follow-up on a report that already has a PR continues its branch.
        // Starting again from main would make the push non-fast-forward.
        const pushed = yield* git(repo, ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`, "--quiet"]).pipe(
          Effect.andThen(git(repo, ["rev-parse", "--verify", `origin/${branch}`])),
          Effect.option
        )
        const base = pushed._tag === "Some"
          ? pushed.value
          : yield* git(repo, ["rev-parse", "--verify", "origin/main"]).pipe(
            Effect.catch(() => git(repo, ["rev-parse", "HEAD"]))
          )
        yield* git(repo, ["worktree", "add", "-b", branch, dir, base])

        // The worktree must define the opencode agents itself (see
        // OpencodeConfig.install), and the copy must not show up as a change
        // the agent could commit. In a worktree `.git` is a file, so the
        // exclude lives in the parent repo's .git/worktrees/<name>/info/exclude:
        // ask git rather than guessing.
        yield* OpencodeConfig.install(dir)
        const exclude = yield* git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
        yield* fs.makeDirectory(path.dirname(exclude), { recursive: true })
        const existing = (yield* fs.exists(exclude)) ? yield* fs.readFileString(exclude) : ""
        yield* fs.writeFileString(exclude, `${existing}\n.opencode/\n`)

        return { dir, branch, base } satisfies Worktree
      })

      /** Commits on the branch that its base does not have. 0: the agent changed nothing. */
      const commits = (worktree: Worktree) =>
        git(worktree.dir, ["rev-list", "--count", `${worktree.base}..HEAD`]).pipe(Effect.map(Number))

      const dispose = (repo: string, worktree: Worktree) =>
        Effect.all([
          Effect.ignore(git(repo, ["worktree", "remove", "--force", worktree.dir])),
          Effect.ignore(git(repo, ["branch", "-D", worktree.branch]))
        ], { discard: true })

      const acquire = (repo: string, shortId: string) =>
        Effect.acquireRelease(
          create(repo, shortId),
          // Keep the worktree only when it holds work worth looking at; an
          // abandoned one per report that needed no change would pile up
          // silently. When the count itself fails, keep it: losing work is
          // worse than a stray directory.
          (worktree) =>
            commits(worktree).pipe(
              Effect.orElseSucceed(() => 1),
              Effect.flatMap((n) => (n === 0 ? dispose(repo, worktree) : Effect.void))
            )
        ).pipe(Effect.provide(services))

      return Worktrees.of({ acquire })
    })
  )
}
