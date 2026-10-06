import type { QueuedReport } from "@skusez/pokecenter/Domain"
import { define } from "@skusez/pokecenter/Profile"

export const profile = define({
  name: "Example Co",
  about: "Example Co's booking software. Office staff at member businesses write in.",
  owner: "Sam",
  categories: {
    web: { description: "The booking website customers use", repo: "web" },
    mobile: { description: "The phone app", repo: "mobile-app" },
    billing: { description: "Invoices from the accounts team" }
  },
  investigator: { instructions: "Run `bun test` before committing." }
})

export const report = (overrides: Partial<QueuedReport> = {}): QueuedReport => ({
  id: "r1",
  short_id: "AB12",
  received_at: "2026-10-01T10:00:00Z",
  from_addr: "jane@example.com",
  reply_to: null,
  subject: "List shows ten rows",
  body: "The bookings list only shows ten rows.",
  forwarded: 0,
  status: "queued",
  verdict: "queue",
  reason: "bookings list truncated",
  category: "web",
  severity: "medium",
  outcome: null,
  branch: null,
  pr_url: null,
  findings: null,
  attachments: null,
  suspicious: 0,
  tg_message: null,
  updated_at: "2026-10-01T10:00:00Z",
  digest: null,
  archived_at: null,
  origin_id: null,
  notes: null,
  followups: null,
  ...overrides
})
