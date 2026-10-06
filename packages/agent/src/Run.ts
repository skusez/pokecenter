import type { QueuedReport } from "@skusez/pokecenter/Domain"
import { TRIAGE_FAILED } from "@skusez/pokecenter/Domain"
import type { ReportPatch } from "@skusez/pokecenter/Api"
import { Cause, Console, Effect, Exit } from "effect"
import { AgentConfig } from "./AgentConfig.ts"
import { Client } from "./Client.ts"
import { Digester } from "./Digester.ts"
import { describe } from "./Errors.ts"
import { progressSink } from "./Events.ts"
import { findingsOf, Investigator } from "./Investigator.ts"

/** Statuses whose threads get a digest during a run: the mail a person will open next. */
export const DIGEST_ON_RUN = ["queued", "needs_owner"] as const
/** Every status worth a digest when backfilling. Ignored mail is skipped: nobody opens those threads. */
export const DIGEST_BACKFILL = ["queued", "investigating", "needs_owner", "error", "done"] as const

const patch = Effect.fn("patch")(function*(id: string, payload: ReportPatch) {
  const client = yield* Client
  const result = yield* client.agent.patchReport({ params: { id }, payload })
  if (!result.notified) yield* Console.warn(`  ! notification failed for ${id}`)
})

/**
 * Triage itself happens in the worker, as mail arrives. This retries it for
 * anything the model could not be reached for.
 */
export const triagePending = Effect.gen(function*() {
  const client = yield* Client
  const { results } = yield* client.agent.triage({ payload: {} }).pipe(
    Effect.catch((error) =>
      Console.error(`retriage failed: ${describe(error).slice(0, 300)}`).pipe(Effect.as({ results: [] }))
    )
  )
  for (const r of results) {
    yield* Console.log(`${(r.verdict === TRIAGE_FAILED ? "still failing" : r.status).padEnd(13)} ${r.subject}`)
  }
})

const investigateOne = Effect.fn("investigateOne")(function*(report: QueuedReport) {
  const investigator = yield* Investigator
  yield* Console.log(`investigating: ${report.subject}`)
  yield* patch(report.id, { status: "investigating" })

  // The progress sink flushes as its scope closes, so the thread shows the
  // whole run before the final status lands.
  const exit = yield* Effect.scoped(
    Effect.gen(function*() {
      const progress = yield* progressSink(report.id)
      return yield* investigator.investigate(report, progress.push)
    })
  ).pipe(
    // Stopped from outside (Ctrl-C, the scheduler): hand it back to the queue
    // rather than leave it "investigating" forever.
    Effect.onInterrupt(() => Effect.ignore(patch(report.id, { status: "queued" }))),
    Effect.exit
  )

  if (Exit.isSuccess(exit)) {
    const result = exit.value
    yield* patch(report.id, {
      status: "done",
      outcome: result.outcome,
      branch: result.branch,
      pr_url: result.pr_url,
      findings: findingsOf(result)
    })
    yield* Console.log(`  → ${result.outcome}${result.pr_url ? ` ${result.pr_url}` : ""}`)
  } else if (Cause.hasInterruptsOnly(exit.cause)) {
    return yield* Effect.interrupt
  } else {
    const message = describe(Cause.squash(exit.cause))
    yield* patch(report.id, { status: "error", findings: message.slice(0, 2_000) })
    yield* Console.error(`  → failed: ${message}`)
  }
})

/** Investigates up to `MAX_INVESTIGATIONS_PER_RUN` queued reports, one at a time. */
export const investigateQueued = Effect.gen(function*() {
  const client = yield* Client
  const { maxInvestigationsPerRun } = yield* AgentConfig
  const { reports } = yield* client.agent.queue({ query: { status: "queued", limit: maxInvestigationsPerRun } })
  for (const report of reports) {
    yield* investigateOne(report).pipe(
      Effect.catch((error) => Console.error(`  → could not update ${report.short_id}: ${describe(error)}`))
    )
  }
})

export interface RunOptions {
  /** Retry triage and write digests only. */
  readonly triageOnly: boolean
  /** Investigate only. */
  readonly investigateOnly: boolean
}

/**
 * One pass of the agent. Scheduled as two jobs: a fast one with
 * `--triage-only` and a slow one with `--investigate-only`. An investigation
 * can run for 45 minutes, and sharing a job would hold every digest behind it.
 */
export const run = Effect.fn("run")(function*(options: RunOptions) {
  if (!options.investigateOnly) {
    yield* triagePending
    const digester = yield* Digester
    yield* digester.digestMissing(DIGEST_ON_RUN, 25)
  }
  if (!options.triageOnly) yield* investigateQueued
})
