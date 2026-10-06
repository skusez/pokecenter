import type { QueuedReport } from "@skusez/pokecenter/Domain"
import type { TriageResult } from "@skusez/pokecenter/Api"
import { type Backend, BACKENDS } from "@skusez/pokecenter/Profile"
import { Console, Effect } from "effect"
import { Client } from "./Client.ts"
import { CurrentProfile } from "./CurrentProfile.ts"
import { ConfigInvalid } from "./Errors.ts"

// Runs a triage backend over mail that has already been through triage and
// compares its answer with where each report ended up, which includes every
// "Investigate anyway" and "Ignore" the owner pressed. Nothing is written or
// sent: the worker's /triage runs dry. Use it to pick the profile's
// `ignoreConfidence`, and to try a backend before switching to it.

type Truth = "queue" | "needs_owner" | "ignore"

const TRUTH: Record<string, Truth> = {
  queued: "queue",
  investigating: "queue",
  done: "queue",
  error: "queue",
  needs_owner: "needs_owner",
  ignored: "ignore"
}

const LABELS: ReadonlyArray<Truth> = ["queue", "needs_owner", "ignore"]
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]

export interface ReplayOptions {
  readonly backend: string | undefined
  readonly limit: number
  /** Leave the screenshots out, to see what they change. */
  readonly noImages: boolean
}

export const replay = Effect.fn("replay")(function*(options: ReplayOptions) {
  const client = yield* Client
  const profile = yield* CurrentProfile
  const backend = (options.backend ?? profile.backend) as Backend
  if (!BACKENDS.includes(backend)) {
    return yield* new ConfigInvalid({ message: `--backend must be one of ${BACKENDS.join(", ")}` })
  }
  const threshold = profile.ignoreConfidence[backend]

  const reports: Array<QueuedReport & { truth: Truth }> = []
  for (const [status, truth] of Object.entries(TRUTH)) {
    const { reports: page } = yield* client.agent.queue({ query: { status, limit: options.limit } })
    for (const report of page) {
      // Bulk mail is filed from its headers before triage would ever see it.
      if (report.reason?.startsWith("bulk mail:")) continue
      reports.push({ ...report, truth })
    }
  }
  yield* Console.log(
    `${reports.length} past reports, asking ${backend}${options.noImages ? " without screenshots" : ""}`
  )

  const results = new Map<string, TriageResult>()
  for (let i = 0; i < reports.length; i += 20) {
    const ids = reports.slice(i, i + 20).map((r) => r.id)
    const response = yield* client.agent.triage({
      payload: { ids, dry: true, backend, ...(options.noImages ? { images: false } : {}) }
    })
    for (const result of response.results) results.set(result.id, result)
    process.stdout.write(".")
  }
  yield* Console.log("")

  const rows = reports.flatMap((r) => {
    const result = results.get(r.id)
    return result ? [{ ...r, result }] : []
  })
  const failed = rows.filter((r) => !r.result.scores)
  if (failed.length) yield* Console.log(`${failed.length} failed: ${failed[0]!.result.reason}`)
  const answered = rows.flatMap((r) => (r.result.scores ? [{ ...r, scores: r.result.scores }] : []))

  yield* Console.log(`\nwhere it ended up → what ${backend} picked`)
  yield* Console.log(`${"".padEnd(14)}${LABELS.map((l) => l.padStart(14)).join("")}`)
  for (const truth of LABELS) {
    const row = LABELS.map((picked) => answered.filter((r) => r.truth === truth && r.result.verdict === picked).length)
    yield* Console.log(`${truth.padEnd(14)}${row.map((n) => String(n).padStart(14)).join("")}`)
  }

  // The cost that matters: a real report filed silently. The other side is
  // noise that still gets a card.
  yield* Console.log("\nignore confidence   real mail binned unseen   noise still carded")
  for (const t of THRESHOLDS) {
    const binned = (r: (typeof answered)[number]) => r.result.verdict === "ignore" && r.scores.confidence >= t
    const lost = answered.filter((r) => r.truth !== "ignore" && binned(r))
    const noisy = answered.filter((r) => r.truth === "ignore" && !binned(r))
    yield* Console.log(
      `${String(t).padEnd(20)}${String(lost.length).padEnd(26)}${noisy.length}${t === threshold ? "   ← current" : ""}`
    )
  }

  const carded = answered.filter((r) => r.truth === "ignore" && r.result.status !== "ignored")
  if (carded.length) {
    yield* Console.log(`\nNoise that would still send a card:`)
    for (const r of carded) {
      yield* Console.log(`  ${r.result.status.padEnd(13)} ${(r.scores.verdict.ignore ?? 0).toFixed(2)}  ${r.subject}`)
    }
  }

  const lost = answered.filter((r) =>
    r.truth !== "ignore" && r.result.verdict === "ignore" && r.scores.confidence >= threshold
  )
  if (lost.length) {
    yield* Console.log(`\nReal mail the current threshold would bin:`)
    for (const r of lost) yield* Console.log(`  ${r.scores.confidence.toFixed(2)}  ${r.truth.padEnd(13)} ${r.subject}`)
  }

  // Where the real mail would go, and which repo its category sends the
  // investigator to. There is no stored truth for category; read it by eye.
  yield* Console.log(`\nReal mail:`)
  for (const r of answered.filter((r) => r.truth !== "ignore")) {
    yield* Console.log(`  ${r.truth.padEnd(13)} → ${r.result.status.padEnd(13)} ${r.result.category.padEnd(17)} ${r.subject}`)
  }
})
