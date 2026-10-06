import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GitFailed } from "./Errors.ts"

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs a command to completion and collects both streams. A non-zero exit is
 * a result, not a failure: callers decide what it means. Fails only when the
 * command cannot be started at all.
 */
export const exec = Effect.fn("exec")(function*(command: string, args: ReadonlyArray<string>, options: {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
} = {}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: true })
  )
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
    { concurrency: "unbounded" }
  )
  return { exitCode: Number(exitCode), stdout, stderr } satisfies ExecResult
}, Effect.scoped)

/** `git <args>` in `cwd`, trimmed stdout, or `GitFailed` with git's own complaint. */
export const git = (cwd: string, args: ReadonlyArray<string>) =>
  exec("git", args, { cwd }).pipe(
    Effect.catch((cause) => Effect.fail(new GitFailed({ args: [...args], cwd, message: cause.message }))),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(
          new GitFailed({
            args: [...args],
            cwd,
            message: `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
          })
        )
    )
  )
