import { BACKENDS } from "@skusez/pokecenter/Profile"
import { Console, Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { AgentConfig } from "./AgentConfig.ts"
import { Client } from "./Client.ts"
import { ConfigPath, CurrentProfile } from "./CurrentProfile.ts"
import { Digester } from "./Digester.ts"
import { doctor } from "./Doctor.ts"
import { install } from "./Install.ts"
import { Investigator } from "./Investigator.ts"
import { Opencode } from "./Opencode.ts"
import { replay } from "./Replay.ts"
import { DIGEST_BACKFILL, run } from "./Run.ts"
import { status } from "./Status.ts"
import { Worktrees } from "./Worktrees.ts"

export const VERSION = "0.1.0"

const ClientLayer = Client.layer.pipe(Layer.provideMerge(AgentConfig.layer))

/** Everything a run needs. The platform (processes, files) comes from the runtime. */
const AgentLayer = Layer.mergeAll(Investigator.layer, Digester.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Opencode.layer, Worktrees.layer)),
  Layer.provideMerge(Layer.mergeAll(ClientLayer, CurrentProfile.layer))
)

const runCommand = Command.make(
  "run",
  {
    triageOnly: Flag.Boolean("triage-only").pipe(
      Flag.withDescription("Retry triage and write digests; investigate nothing"), Flag.withDefault(false)
    ),
    investigateOnly: Flag.Boolean("investigate-only").pipe(
      Flag.withDescription("Investigate queued reports; skip triage and digests"), Flag.withDefault(false)
    )
  },
  (options) => run(options).pipe(Effect.provide(AgentLayer))
).pipe(
  Command.withDescription(
    "One pass: retry pending triage, write missing digests, then investigate up to MAX_INVESTIGATIONS_PER_RUN queued reports"
  )
)

const statusCommand = Command.make("status", {}, () => status.pipe(Effect.provide(ClientLayer))).pipe(
  Command.withDescription("List reports by status")
)

const digestCommand = Command.make("digest", {}, () =>
  Effect.gen(function*() {
    const digester = yield* Digester
    yield* digester.digestMissing(DIGEST_BACKFILL, 100)
  }).pipe(Effect.provide(AgentLayer))).pipe(
    Command.withDescription("Backfill digests for every report worth opening")
  )

const replayCommand = Command.make(
  "replay",
  {
    backend: Flag.Literals("backend", BACKENDS).pipe(
      Flag.withDescription("Triage backend to try (default: the profile's)"),
      Flag.optional
    ),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Past reports per status"), Flag.withDefault(300)),
    noImages: Flag.Boolean("no-images").pipe(Flag.withDescription("Leave the screenshots out, to see what they change"), Flag.withDefault(false))
  },
  ({ backend, limit, noImages }) =>
    replay({ backend: Option.getOrUndefined(backend), limit, noImages }).pipe(
      Effect.provide(Layer.mergeAll(ClientLayer, CurrentProfile.layer))
    )
).pipe(
  Command.withDescription(
    "Re-run triage dry over past mail and compare with where each report ended up. Writes and sends nothing"
  )
)

const webhookRegister = Command.make("register", {}, () =>
  Effect.gen(function*() {
    const client = yield* Client
    const result = yield* client.agent.registerWebhook({})
    yield* Console.log(result.ok ? "Telegram webhook registered." : `Telegram refused: ${result.description ?? "no reason given"}`)
    if (!result.ok) process.exitCode = 1
  }).pipe(Effect.provide(ClientLayer))).pipe(
    Command.withDescription("Point the Telegram bot's webhook at the worker (POST /tg/register)")
  )

const webhookCommand = Command.make("webhook").pipe(
  Command.withDescription("Telegram webhook"),
  Command.withSubcommands([webhookRegister])
)

const doctorCommand = Command.make("doctor", {}, () => doctor).pipe(
  Command.withDescription("Check configuration, the worker, opencode, git, gh and every repo checkout")
)

const installCommand = Command.make(
  "install",
  { dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Print the files instead of writing them"), Flag.withDefault(false)) },
  ({ dryRun }) => install({ dryRun }).pipe(Effect.provide(Layer.mergeAll(AgentConfig.layer, CurrentProfile.layer)))
).pipe(
  Command.withDescription(
    "Write launchd jobs (macOS) or systemd user timers (Linux): run --triage-only every 5 minutes, run --investigate-only every 10. Prints how to load them; loads nothing"
  )
)

export const pokecenter = Command.make("pokecenter").pipe(
  Command.withDescription("The local agent for a pokecenter inbox: digests and investigations"),
  Command.withSubcommands([
    runCommand,
    statusCommand,
    digestCommand,
    replayCommand,
    webhookCommand,
    doctorCommand,
    installCommand
  ]),
  Command.withGlobalFlags([ConfigPath])
)

export const cli = Command.run(pokecenter, { version: VERSION })
