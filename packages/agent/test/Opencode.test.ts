import { BunServices } from "@effect/platform-bun"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Redacted, Result } from "effect"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentConfig } from "../src/AgentConfig.ts"
import { extractJson, instruct, Opencode, textOf } from "../src/Opencode.ts"

describe("extractJson", () => {
  test("a bare object with every required key", () => {
    const result = extractJson(`{"a": 1, "b": null}`, ["a", "b"])
    expect(Result.getOrThrow(result)).toEqual({ a: 1, b: null })
  })

  test("an object wrapped in prose or a fence", () => {
    const result = extractJson("Here you go:\n```json\n{\"a\": \"x\"}\n```\nDone.", ["a"])
    expect(Result.getOrThrow(result)).toEqual({ a: "x" })
  })

  test("a missing required key fails, naming it", () => {
    const result = extractJson(`{"a": 1}`, ["a", "b", "c"])
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("OpencodeNoJson")
      expect(result.failure.message).toContain("omitted b, c")
    }
  })

  test("no object, or a broken one, fails", () => {
    expect(Result.isFailure(extractJson("I could not do it.", ["a"]))).toBe(true)
    expect(Result.isFailure(extractJson("{not json}", ["a"]))).toBe(true)
  })
})

describe("textOf", () => {
  test("joins the model's text parts and skips the rest", () => {
    const lines = [
      JSON.stringify({ type: "text", part: { text: "{\"a\":" } }),
      JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
      "garbage",
      JSON.stringify({ type: "text", part: { text: " 1}" } })
    ]
    expect(textOf(lines)).toBe("{\"a\": 1}")
  })
})

test("instruct appends the shape", () => {
  expect(instruct("Do it.", "{\"a\": \"x\"}")).toBe(
    "Do it.\n\nReply with ONLY this JSON object, every key present, no prose and no code fence:\n{\"a\": \"x\"}"
  )
})

describe("Opencode.run against a stand-in binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pokecenter-opencode-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const script = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/bash\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  const runWith = (bin: string, options: Partial<Parameters<Opencode["Service"]["run"]>[0]> = {}) => {
    const config = Layer.succeed(AgentConfig, {
      url: "http://127.0.0.1:1",
      token: Redacted.make("t"),
      repos: { byName: {}, fallback: undefined, entries: [] },
      digestModel: Option.none(),
      investigateModel: Option.none(),
      maxInvestigationsPerRun: 1,
      worktreeRoot: dir,
      opencodeBin: bin,
      stateDir: dir
    })
    return Effect.gen(function*() {
      const opencode = yield* Opencode
      return yield* opencode.run({
        prompt: "p",
        agent: "digest",
        timeout: "10 seconds",
        required: ["a"],
        shape: "{\"a\": 1}",
        cwd: dir,
        attempts: 1,
        ...options
      })
    }).pipe(
      Effect.provide(Opencode.layer.pipe(Layer.provide(Layer.merge(config, BunServices.layer)))),
      Effect.result,
      Effect.runPromise
    )
  }

  test("streams lines, sets PWD to the working directory, and parses the answer", async () => {
    const bin = script(
      "ok.sh",
      `echo '{"type":"tool","part":{"type":"tool","tool":"bash"}}'
echo "{\\"type\\":\\"text\\",\\"part\\":{\\"text\\":\\"{\\\\\\"a\\\\\\": \\\\\\"$PWD\\\\\\"}\\"}}"`
    )
    const seen: Array<string> = []
    const result = await runWith(bin, { onLine: (line) => Effect.sync(() => void seen.push(line)) })
    expect(Result.getOrThrow(result)).toEqual({ a: dir })
    expect(seen).toHaveLength(2)
  })

  test("a non-zero exit is OpencodeFailed with stderr", async () => {
    const result = await runWith(script("fail.sh", "echo 'model not found' >&2; exit 3"))
    expect(Result.isFailure(result) && result.failure._tag).toBe("OpencodeFailed")
    if (Result.isFailure(result)) expect(result.failure.message).toContain("model not found")
  })

  test("silence past the stall window is OpencodeStalled", async () => {
    const result = await runWith(script("stall.sh", "echo '{}'; sleep 5"), { stall: "300 millis" })
    expect(Result.isFailure(result) && result.failure._tag).toBe("OpencodeStalled")
  })

  test("a run past its timeout is OpencodeTimedOut", async () => {
    const result = await runWith(script("slow.sh", "while true; do echo '{}'; sleep 0.1; done"), {
      timeout: "500 millis"
    })
    expect(Result.isFailure(result) && result.failure._tag).toBe("OpencodeTimedOut")
  })

  test("no text at all is OpencodeNoJson", async () => {
    const result = await runWith(script("quiet.sh", "exit 0"))
    expect(Result.isFailure(result) && result.failure._tag).toBe("OpencodeNoJson")
  })

  test("attempts retries a failed run", async () => {
    const counter = join(dir, "count")
    const bin = script(
      "flaky.sh",
      `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}
if [ "$n" = "0" ]; then exit 1; fi
echo '{"type":"text","part":{"text":"{\\"a\\": 2}"}}'`
    )
    const result = await runWith(bin, { attempts: 2 })
    expect(Result.getOrThrow(result)).toEqual({ a: 2 })
  })
})
