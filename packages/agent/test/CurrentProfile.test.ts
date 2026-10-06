import { expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { join } from "node:path"
import { load } from "../src/CurrentProfile.ts"

const loadResult = (path: string) => Effect.runPromise(Effect.result(load(join(import.meta.dir, path))))

test("loads a profile module's default export", async () => {
  const profile = Result.getOrThrow(await loadResult("fixtures/pokecenter.config.ts"))
  expect(profile.name).toBe("Example Co")
  expect(Object.keys(profile.categories)).toEqual(["web", "unknown"])
})

test("a module that is not a profile is ConfigInvalid", async () => {
  const result = await loadResult("fixtures/not-a-profile.ts")
  expect(Result.isFailure(result) && result.failure._tag).toBe("ConfigInvalid")
})

test("a missing module is ConfigInvalid", async () => {
  const result = await loadResult("fixtures/nope.ts")
  expect(Result.isFailure(result) && result.failure.message).toContain("could not load the profile")
})
