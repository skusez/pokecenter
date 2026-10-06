import { Digest, type QueuedReport } from "@skusez/pokecenter/Domain"
import { Console, Context, Effect, FileSystem, Layer, Path, type PlatformError } from "effect"
import { AgentConfig } from "./AgentConfig.ts"
import { attachmentsOf, type ApiError, Client } from "./Client.ts"
import { CurrentProfile } from "./CurrentProfile.ts"
import { describe, type OpencodeError } from "./Errors.ts"
import { decodeAnswer, Opencode } from "./Opencode.ts"
import * as OpencodeConfig from "./OpencodeConfig.ts"
import * as Prompts from "./Prompts.ts"

const decodeDigest = decodeAnswer(Digest)

export class Digester extends Context.Service<Digester, {
  /** The email restated under fixed headings. */
  digest(report: QueuedReport): Effect.Effect<Digest, OpencodeError | PlatformError.PlatformError>
  /** Writes a digest for every report at these statuses that has none yet. One failure does not stop the rest. */
  digestMissing(statuses: ReadonlyArray<string>, limit: number): Effect.Effect<void, ApiError>
}>()("@skusez/pokecenter-agent/Digester") {
  static readonly layer = Layer.effect(
    Digester,
    Effect.gen(function*() {
      const config = yield* AgentConfig
      const profile = yield* CurrentProfile
      const client = yield* Client
      const opencode = yield* Opencode
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      // The digest reads no code, so it runs in a directory of its own that
      // holds nothing but the opencode config defining its agent.
      const workspace = path.join(config.stateDir, "opencode")
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const prepare = Effect.gen(function*() {
        yield* fs.makeDirectory(workspace, { recursive: true })
        yield* OpencodeConfig.install(workspace)
      }).pipe(Effect.provide(services))
      const prepared = yield* Effect.cached(prepare)

      const digest = Effect.fn("Digester.digest")(function*(report: QueuedReport) {
        yield* prepared
        const answer = yield* opencode.run({
          prompt: Prompts.digestPrompt(profile, report, attachmentsOf(report)),
          agent: "digest",
          model: config.digestModel,
          timeout: "3 minutes",
          required: Prompts.DIGEST_REQUIRED,
          shape: Prompts.DIGEST_SHAPE,
          cwd: workspace
        })
        return yield* decodeDigest({ expected: null, details: [], asks: [], ...answer })
      })

      const digestMissing = Effect.fn("Digester.digestMissing")(function*(statuses: ReadonlyArray<string>, limit: number) {
        for (const status of statuses) {
          const { reports } = yield* client.agent.queue({ query: { status, limit } })
          for (const report of reports.filter((r) => !r.digest)) {
            yield* digest(report).pipe(
              Effect.flatMap((d) =>
                client.agent.patchReport({ params: { id: report.id }, payload: { digest: JSON.stringify(d) } })
              ),
              Effect.andThen(Console.log(`digested      ${report.subject}`)),
              Effect.catch((error) =>
                Console.error(`digest failed for "${report.subject}": ${describe(error).slice(0, 300)}`)
              )
            )
          }
        }
      })

      return Digester.of({ digest, digestMissing })
    })
  )
}
