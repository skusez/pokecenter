import { Context, Duration, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AgentConfig } from "./AgentConfig.ts"
import {
  OpencodeFailed,
  type OpencodeError,
  OpencodeNoJson,
  OpencodeStalled,
  OpencodeTimedOut
} from "./Errors.ts"

/**
 * How long a run may go without emitting a line before it is stopped. A run
 * that goes silent has stalled, not thought hard: a subagent's stream has
 * been seen to stop mid-message and sit there until the overall timeout.
 * Every real step emits a line well inside this window.
 */
export const STALL = Duration.minutes(10)

export interface RunOptions {
  readonly prompt: string
  /** An agent defined in the opencode config of `cwd`'s project. */
  readonly agent: string
  readonly timeout: Duration.Input
  /**
   * Keys that must be present. opencode has no schema enforcement, so a
   * dropped field arrives as `undefined` and reads as a valid answer.
   */
  readonly required: ReadonlyArray<string>
  /**
   * Literal JSON the model should echo the shape of. opencode has no
   * `--json-schema`; without an example the model answers with whichever keys
   * it feels like.
   */
  readonly shape: string
  /**
   * Absolute paths attached to the message. The model sees images directly,
   * so vision needs no file-reading tool granted. A relative path is silently
   * ignored by opencode, and the run then produces no output at all.
   */
  readonly files?: ReadonlyArray<string> | undefined
  /** Overrides the agent's configured model: `provider/model#variant`. */
  readonly model?: Option.Option<string> | undefined
  /** Working directory, and the project opencode resolves its agents from. */
  readonly cwd: string
  /** Default 2. Every failure, a stall included, is retried. */
  readonly attempts?: number | undefined
  /** How long the run may go silent. Default `STALL`. */
  readonly stall?: Duration.Input | undefined
  /** Called with each `--format json` line as it is emitted. */
  readonly onLine?: ((line: string) => Effect.Effect<void>) | undefined
}

/** The instruction appended to every prompt, so the answer can be parsed. */
export const instruct = (prompt: string, shape: string): string =>
  `${prompt}\n\nReply with ONLY this JSON object, every key present, no prose and no code fence:\n${shape}`

/**
 * opencode has no `--json-schema`, so the shape is asked for in the prompt and
 * enforced here. The model answers with a bare object today; the regex is the
 * guard for the day it wraps one in prose or a fence.
 */
export const extractJson = (
  raw: string,
  required: ReadonlyArray<string>
): Result.Result<Record<string, unknown>, OpencodeNoJson> => {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return Result.fail(new OpencodeNoJson({ message: `no JSON in opencode output: ${raw.slice(0, 300)}` }))

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch (error) {
    return Result.fail(
      new OpencodeNoJson({ message: `unparseable JSON (${String(error)}) in: ${match[0].slice(0, 300)}` })
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return Result.fail(new OpencodeNoJson({ message: `expected an object, got: ${match[0].slice(0, 300)}` }))
  }
  const record = parsed as Record<string, unknown>
  const missing = required.filter((key) => record[key] === undefined)
  if (missing.length > 0) {
    return Result.fail(
      new OpencodeNoJson({ message: `opencode omitted ${missing.join(", ")} from: ${match[0].slice(0, 300)}` })
    )
  }
  return Result.succeed(record)
}

/** The model's own words in a `--format json` transcript, tool chatter left out. */
export const textOf = (lines: ReadonlyArray<string>): string =>
  lines
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { type?: string; part?: { text?: string } }
        return event?.type === "text" && event.part?.text ? [event.part.text] : []
      } catch {
        return []
      }
    })
    .join("")

/** Checks an extracted answer against the shape its caller expects. */
export const decodeAnswer = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema)
  return (record: Record<string, unknown>): Effect.Effect<S["Type"], OpencodeNoJson> => {
    const result = decode(record)
    return Result.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(new OpencodeNoJson({ message: `answer has the wrong shape: ${result.failure.message.slice(0, 500)}` }))
  }
}

export class Opencode extends Context.Service<Opencode, {
  /** Runs one prompt to a JSON answer holding at least `required`. */
  run(options: RunOptions): Effect.Effect<Record<string, unknown>, OpencodeError>
}>()("@skusez/pokecenter-agent/Opencode") {
  static readonly layer = Layer.effect(
    Opencode,
    Effect.gen(function*() {
      const { opencodeBin } = yield* AgentConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const once = (options: RunOptions) =>
        Effect.gen(function*() {
          const stall = Duration.fromInputUnsafe(options.stall ?? STALL)
          const failed = (cause: { message: string }) =>
            new OpencodeFailed({ exitCode: null, message: `${opencodeBin}: ${cause.message}` })

          const handle = yield* spawner.spawn(
            ChildProcess.make(
              opencodeBin,
              [
                "run",
                "--standalone",
                "--agent",
                options.agent,
                "--format",
                "json",
                ...Option.match(options.model ?? Option.none(), { onNone: () => [], onSome: (m) => ["--model", m] }),
                ...(options.files ?? []).flatMap((file) => ["--file", file]),
                instruct(options.prompt, options.shape)
              ],
              {
                cwd: options.cwd,
                // opencode resolves its project from PWD, not from the process's
                // actual working directory. Spawning sets the latter and inherits
                // the former, so without this every run anchors to wherever the
                // agent was started, and the investigator reads that project
                // instead of the repo under test.
                env: { PWD: options.cwd },
                extendEnv: true
              }
            )
          ).pipe(Effect.mapError(failed))

          const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.forkScoped
          )

          // Read a line at a time so progress is forwarded while the run is
          // still going, rather than after it has ended.
          const lines = yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapError(failed),
            Stream.timeoutOrElse({
              duration: stall,
              orElse: () =>
                Stream.fail(
                  new OpencodeStalled({
                    minutes: Duration.toMinutes(stall),
                    message: `opencode produced no output for ${Duration.format(stall)} and was stopped`
                  })
                )
            }),
            Stream.filter((line) => line.trim() !== ""),
            Stream.tap((line) => options.onLine?.(line) ?? Effect.void),
            Stream.runCollect
          )

          const exitCode = Number(yield* handle.exitCode.pipe(Effect.mapError(failed)))
          if (exitCode !== 0) {
            const err = yield* Fiber.join(stderr)
            return yield* new OpencodeFailed({ exitCode, message: `opencode exited ${exitCode}: ${err.slice(0, 1000)}` })
          }

          const text = textOf(lines)
          if (!text.trim()) return yield* new OpencodeNoJson({ message: `opencode produced no text (exit ${exitCode})` })
          const answer = extractJson(text, options.required)
          return Result.isSuccess(answer) ? answer.success : yield* answer.failure
        }).pipe(
          Effect.scoped,
          // Leaving the scope stops the process, so a timed-out run does not
          // linger in the background.
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () => {
              const timeout = Duration.fromInputUnsafe(options.timeout)
              return Effect.fail(
                new OpencodeTimedOut({
                  minutes: Duration.toMinutes(timeout),
                  message: `opencode ran past ${Duration.format(timeout)} and was stopped`
                })
              )
            }
          })
        )

      const run = Effect.fn("Opencode.run")(function*(options: RunOptions) {
        yield* Effect.annotateCurrentSpan({ agent: options.agent, cwd: options.cwd })
        return yield* once(options).pipe(Effect.retry({ times: Math.max(0, (options.attempts ?? 2) - 1) }))
      })

      return Opencode.of({ run })
    })
  )
}
