import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Client } from "../src/Client.ts"
import { BATCH_SIZE, progressSink, toStep } from "../src/Events.ts"

describe("toStep", () => {
  test("text and reasoning parts become steps", () => {
    expect(toStep(JSON.stringify({ type: "text", part: { type: "text", text: "Looking at the list." } }))).toEqual({
      kind: "step",
      body: { type: "text", text: "Looking at the list." }
    })
    expect(toStep(JSON.stringify({ part: { type: "reasoning", text: "hmm" } }))?.body).toEqual({ type: "reasoning", text: "hmm" })
  })

  test("a tool call is titled by its argument, not its name", () => {
    const step = toStep(
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git log -5" }, output: "abc" } }
      })
    )
    expect(step?.body).toEqual({
      type: "tool",
      tool: "bash",
      status: "completed",
      title: "git log -5",
      input: JSON.stringify({ command: "git log -5" }),
      output: "abc"
    })
  })

  test("long text is clipped", () => {
    const text = toStep(JSON.stringify({ part: { type: "text", text: "x".repeat(9_000) } }))?.body.text as string
    expect(text.length).toBe(8_001)
    expect(text.endsWith("…")).toBe(true)
  })

  test("errors are kept", () => {
    expect(toStep(JSON.stringify({ type: "error", error: { message: "rate limited" } }))?.body).toEqual({
      type: "error",
      text: JSON.stringify({ message: "rate limited" })
    })
  })

  test("bookkeeping, empty text and non-JSON are dropped", () => {
    expect(toStep(JSON.stringify({ type: "step_start", part: { type: "step-start" } }))).toBeNull()
    expect(toStep(JSON.stringify({ part: { type: "text", text: "" } }))).toBeNull()
    expect(toStep("not json")).toBeNull()
    expect(toStep("null")).toBeNull()
  })
})

describe("progressSink", () => {
  test("batches steps and posts everything before the scope closes", async () => {
    const posted: Array<{ report_id: string; events: ReadonlyArray<unknown> }> = []
    const client = Layer.succeed(Client, {
      agent: {
        postEvents: ({ payload }: { payload: { report_id: string; events: ReadonlyArray<unknown> } }) =>
          Effect.sync(() => {
            posted.push(payload)
            return { ok: true, count: payload.events.length }
          })
      }
    } as unknown as Client["Service"])

    const line = (i: number) => JSON.stringify({ part: { type: "text", text: `step ${i}` } })
    await Effect.scoped(
      Effect.gen(function*() {
        const sink = yield* progressSink("r1")
        for (let i = 0; i < BATCH_SIZE + 5; i++) yield* sink.push(line(i))
        yield* sink.push("ignored bookkeeping")
      })
    ).pipe(Effect.provide(client), Effect.runPromise)

    expect(posted.every((p) => p.report_id === "r1")).toBe(true)
    expect(posted.flatMap((p) => p.events)).toHaveLength(BATCH_SIZE + 5)
    expect(posted.length).toBeGreaterThanOrEqual(2)
    expect(posted.every((p) => p.events.length <= BATCH_SIZE)).toBe(true)
  })

  test("a failed post is logged, not fatal", async () => {
    const client = Layer.succeed(Client, {
      agent: { postEvents: () => Effect.fail(new Error("worker down")) }
    } as unknown as Client["Service"])
    await Effect.scoped(
      Effect.gen(function*() {
        const sink = yield* progressSink("r1")
        yield* sink.push(JSON.stringify({ part: { type: "text", text: "hi" } }))
      })
    ).pipe(Effect.provide(client), Effect.runPromise)
  })
})
