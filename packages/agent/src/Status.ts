import { Console, Effect } from "effect"
import { Client } from "./Client.ts"

const STATUSES = ["new", "queued", "investigating", "needs_owner", "error", "done"] as const

/** What is waiting at each status, newest twenty of each. */
export const status = Effect.gen(function*() {
  const client = yield* Client
  let any = false
  for (const status of STATUSES) {
    const { reports } = yield* client.agent.queue({ query: { status, limit: 20 } })
    if (reports.length === 0) continue
    any = true
    yield* Console.log(`\n${status} (${reports.length})`)
    for (const r of reports) {
      yield* Console.log(
        `  ${r.received_at.slice(0, 16)}  ${r.subject}  — ${r.from_addr}${r.pr_url ? `\n      ${r.pr_url}` : ""}`
      )
    }
  }
  if (!any) yield* Console.log("Nothing waiting.")
})
