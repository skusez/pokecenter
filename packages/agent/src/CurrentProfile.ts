import type { Profile } from "@skusez/pokecenter/Profile"
import { Context, Effect, Layer } from "effect"
import { Flag, GlobalFlag } from "effect/cli"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ConfigInvalid } from "./Errors.ts"

export const DEFAULT_PROFILE_PATH = "./pokecenter.config.ts"

/** `--config <path>`, accepted by every command. */
export const ConfigPath = GlobalFlag.Setting("config")({
  flag: Flag.String("config").pipe(
    Flag.withDescription("The inbox profile: a module whose default export is Profile.define(...)"),
    Flag.withDefault(DEFAULT_PROFILE_PATH)
  )
})

const isProfile = (value: unknown): value is Profile =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Profile).name === "string" &&
  typeof (value as Profile).about === "string" &&
  typeof (value as Profile).owner === "string" &&
  typeof (value as Profile).categories === "object" &&
  typeof (value as Profile).investigatorInstructions === "string"

/** Imports the profile module. Its default export must come from `Profile.define`. */
export const load = (path: string): Effect.Effect<Profile, ConfigInvalid> => {
  const absolute = resolve(path)
  return Effect.tryPromise({
    try: () => import(pathToFileURL(absolute).href) as Promise<{ default?: unknown }>,
    catch: (cause) =>
      new ConfigInvalid({
        message: `could not load the profile at ${absolute}: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  }).pipe(
    Effect.flatMap((module) =>
      isProfile(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(
          new ConfigInvalid({
            message: `${absolute} must \`export default Profile.define({ ... })\` from "@skusez/pokecenter/Profile"`
          })
        )
    )
  )
}

/** The inbox profile this run serves. */
export class CurrentProfile extends Context.Service<CurrentProfile, Profile>()("@skusez/pokecenter-agent/CurrentProfile") {
  /** Reads the path from `--config`. */
  static readonly layer = Layer.effect(
    CurrentProfile,
    Effect.gen(function*() {
      return yield* load(yield* ConfigPath)
    })
  )
  static readonly fromPath = (path: string) => Layer.effect(CurrentProfile, load(path))
}
