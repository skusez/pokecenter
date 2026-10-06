import type { Profile } from "@skusez/pokecenter/Profile"
import { Cause, Console, Effect, Exit, FileSystem, Layer } from "effect"
import * as AgentConfig from "./AgentConfig.ts"
import { Client } from "./Client.ts"
import * as CurrentProfile from "./CurrentProfile.ts"
import { describe } from "./Errors.ts"
import { exec } from "./Exec.ts"

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** Repos the profile's categories name that `REPOS` has no checkout for. */
export const missingRepos = (profile: Profile, repos: AgentConfig.Repos): ReadonlyArray<{ category: string; repo: string }> =>
  Object.entries(profile.categories).flatMap(([category, { repo }]) =>
    repo && !(repo in repos.byName) ? [{ category, repo }] : []
  )

export const formatChecks = (checks: ReadonlyArray<Check>): string =>
  checks.map((c) => `${c.ok ? "pass" : "FAIL"}  ${c.name}${c.detail ? `\n        ${c.detail}` : ""}`).join("\n")

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

/** Runs a command and passes when it exits 0. */
const commandCheck = (name: string, command: string, args: ReadonlyArray<string>, cwd?: string) =>
  exec(command, args, { cwd }).pipe(
    Effect.map((r): Check => ({
      name,
      ok: r.exitCode === 0,
      detail: firstLine(r.exitCode === 0 ? r.stdout || r.stderr : r.stderr || r.stdout || `exit ${r.exitCode}`)
    })),
    Effect.catch((error) => Effect.succeed<Check>({ name, ok: false, detail: describe(error) }))
  )

/**
 * Everything a scheduled run needs, checked in the order a person would fix
 * it. Never changes anything.
 */
export const doctor = Effect.gen(function*() {
  const checks: Array<Check> = []
  const record = (check: Check) =>
    Effect.sync(() => checks.push(check)).pipe(Effect.andThen(Console.log(formatChecks([check]))))

  const configExit = yield* Effect.exit(AgentConfig.load)
  yield* record({
    name: "configuration loads (POKECENTER_URL, POKECENTER_TOKEN, …)",
    ok: Exit.isSuccess(configExit),
    detail: Exit.isSuccess(configExit) ? configExit.value.url : describeExit(configExit)
  })

  const profilePath = yield* CurrentProfile.ConfigPath
  const profileExit = yield* Effect.exit(CurrentProfile.load(profilePath))
  yield* record({
    name: `profile loads (${profilePath})`,
    ok: Exit.isSuccess(profileExit),
    detail: Exit.isSuccess(profileExit)
      ? `${profileExit.value.name}: ${Object.keys(profileExit.value.categories).join(", ")}`
      : describeExit(profileExit)
  })

  if (Exit.isSuccess(configExit)) {
    const config = configExit.value
    const client = Client.layer.pipe(Layer.provide(Layer.succeed(AgentConfig.AgentConfig, config)))

    yield* Effect.gen(function*() {
      const api = yield* Client
      const health = yield* Effect.exit(api.health())
      yield* record({
        name: "worker reachable (GET /healthz)",
        ok: Exit.isSuccess(health),
        detail: Exit.isSuccess(health) ? "" : describeExit(health)
      })
      const queue = yield* Effect.exit(api.agent.queue({ query: { limit: 1 } }))
      yield* record({
        name: "token accepted (GET /queue)",
        ok: Exit.isSuccess(queue),
        detail: Exit.isSuccess(queue) ? "" : describeExit(queue)
      })
    }).pipe(Effect.provide(client))

    yield* record(yield* commandCheck(`opencode runs (${config.opencodeBin} --version)`, config.opencodeBin, ["--version"]))
    yield* record(yield* commandCheck("git runs", "git", ["--version"]))
    yield* record(yield* commandCheck("gh is signed in (gh auth status)", "gh", ["auth", "status"]))

    const fs = yield* FileSystem.FileSystem
    if (config.repos.entries.length === 0) {
      yield* record({ name: "REPOS lists at least one checkout", ok: false, detail: "set REPOS=name=/path/to/repo,…" })
    }
    for (const [name, path] of config.repos.entries) {
      const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      yield* record(
        exists
          ? yield* commandCheck(`REPOS ${name} is a git repo (${path})`, "git", ["rev-parse", "--show-toplevel"], path)
          : { name: `REPOS ${name} exists (${path})`, ok: false, detail: "no such directory" }
      )
    }

    if (Exit.isSuccess(profileExit)) {
      const missing = missingRepos(profileExit.value, config.repos)
      yield* record({
        name: "every category's repo has a REPOS entry",
        ok: missing.length === 0,
        detail: missing.map((m) => `${m.category} → ${m.repo}: add ${m.repo}=<path> to REPOS`).join("; ")
      })
    }
  }

  const failed = checks.filter((c) => !c.ok)
  yield* Console.log(
    failed.length === 0 ? `\nAll ${checks.length} checks passed.` : `\n${failed.length} of ${checks.length} checks failed.`
  )
  if (failed.length > 0) process.exitCode = 1
  return checks
})

const describeExit = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? describe(Cause.squash(exit.cause)) : ""
