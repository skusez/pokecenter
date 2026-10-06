#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { CliError } from "effect/cli"
import { cli } from "./Cli.ts"
import { describe } from "./Errors.ts"

cli.pipe(
  // The CLI renders its own usage errors; anything else is one line, not a stack.
  Effect.catchIf(
    (error) => !CliError.isCliError(error),
    (error) => Console.error(`pokecenter: ${describe(error)}`).pipe(Effect.andThen(Effect.sync(() => {
      process.exitCode = 1
    })))
  ),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
