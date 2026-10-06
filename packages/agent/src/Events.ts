import { Cause, Effect, Fiber, Queue, Stream } from "effect"
import { Client } from "./Client.ts"
import { describe } from "./Errors.ts"

export interface StepEvent {
  readonly kind: "step"
  readonly body: Record<string, unknown>
}

const clip = (value: unknown, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Reduces an opencode `--format json` line to what a thread needs to show:
 * the text it wrote, the tool it called and what came back. Anything it does
 * not recognise is dropped rather than stored raw: the log is read by a
 * person, and a screen of session bookkeeping would hide the work.
 */
export const toStep = (raw: string): StepEvent | null => {
  let event: { type?: string; part?: Record<string, any>; error?: unknown }
  try {
    event = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof event !== "object" || event === null) return null
  const part = event.part ?? {}
  const kind = part.type ?? event.type

  if (kind === "text" && part.text) return { kind: "step", body: { type: "text", text: clip(part.text, 8_000) } }
  if (kind === "reasoning" && part.text) return { kind: "step", body: { type: "reasoning", text: clip(part.text, 2_000) } }
  if (kind === "tool" || kind === "tool_use" || kind === "tool-invocation") {
    const state = part.state ?? {}
    const input = state.input ?? part.input ?? {}
    return {
      kind: "step",
      body: {
        type: "tool",
        tool: part.tool ?? part.name ?? "tool",
        status: state.status,
        // opencode's own title is the tool name; the argument is what a
        // reader wants to see at a glance.
        title: clip(
          input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.query ?? input.description ?? state.title,
          160
        ),
        input: clip(input, 2_000),
        output: clip(state.output ?? part.output, 4_000)
      }
    }
  }
  if (event.type === "error") return { kind: "step", body: { type: "error", text: clip(event.error, 2_000) } }
  return null
}

/** Steps posted in one round trip at most, and how long a step may wait for company. */
export const BATCH_SIZE = 25
export const BATCH_WINDOW = "1500 millis"

/**
 * Buffers a run's progress and posts it in batches. A run emits hundreds of
 * parts and one round trip each would slow the investigation for no reader's
 * benefit. Everything pushed is posted by the time the scope closes, so the
 * thread shows the whole run before the report's final status lands. A post
 * that fails is logged and dropped: progress is a courtesy, not the result.
 */
export const progressSink = Effect.fn("progressSink")(function*(reportId: string) {
  const client = yield* Client
  const queue = yield* Queue.unbounded<StepEvent, Cause.Done>()

  const poster = yield* Stream.fromQueue(queue).pipe(
    Stream.groupedWithin(BATCH_SIZE, BATCH_WINDOW),
    Stream.runForEach((events) =>
      client.agent.postEvents({ payload: { report_id: reportId, events } }).pipe(
        Effect.catch((error) => Effect.logWarning(`progress not posted: ${describe(error).slice(0, 200)}`))
      )
    ),
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() => Queue.end(queue).pipe(Effect.andThen(Fiber.join(poster)), Effect.ignore))

  /** Feed it raw opencode lines; it keeps the ones a reader wants. */
  const push = (line: string): Effect.Effect<void> => {
    const step = toStep(line)
    return step ? Effect.asVoid(Queue.offer(queue, step)) : Effect.void
  }
  return { push }
})
