import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Profile } from "@skusez/pokecenter"
import { Effect, Layer, ManagedRuntime } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { readdirSync, readFileSync } from "node:fs"
import { Attachments } from "../src/Attachments.ts"
import { AuthPolicy } from "../src/Auth.ts"
import { Classifier } from "../src/Classifier.ts"
import { ApiLive, Secrets, Settings } from "../src/Handlers.ts"
import { Backend, Inbox } from "../src/Inbox.ts"
import { MIGRATIONS_DIR } from "../src/Paths.ts"
import { Store } from "../src/Store.ts"
import { Telegram } from "../src/Telegram.ts"

const profile = Profile.define({
  name: "Acme",
  about: "Acme's billing software, which small shops use",
  owner: "Sam",
  categories: { billing: { description: "Invoices and payments", repo: "acme-billing" } },
  ui: { signIn: { label: "Sign in to Acme", url: "https://acme.test/signin" } }
})

const TOKEN = "agent-token"

const sent: Array<{ status: string; as?: string }> = []

const verdicts = new Map<string, "queue" | "ignore">()

const TelegramFake = Layer.succeed(
  Telegram,
  Telegram.of({
    chatId: "1",
    call: () => Effect.succeed(undefined),
    reply: () => Effect.void,
    answer: () => Effect.void,
    notify: (report, as) =>
      Effect.sync(() => {
        // Like the real one: ignored mail only rewrites a card it already had.
        if (report.status === "ignored" && !as && !report.tg_message) return null
        sent.push({ status: report.status, ...(as ? { as } : {}) })
        return 100 + sent.length
      }),
    setWebhook: () => Effect.succeed({ ok: true })
  })
)

const ClassifierFake = Layer.succeed(
  Classifier,
  Classifier.of({
    judge: (report) =>
      Effect.succeed({
        status: verdicts.get(report.subject) === "ignore" ? "ignored" : "queued",
        verdict: verdicts.get(report.subject) ?? "queue",
        reason: "test",
        category: "billing",
        severity: "low",
        suspicious: false,
        scores: { model: "fake", verdict: {}, confidence: 1, directs_reader: 0 }
      } as const)
  })
)

const Migrated = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
      for (const statement of readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8").split(/;\s*$/m)) {
        if (statement.replace(/--.*$/gm, "").trim()) yield* sql.unsafe(statement)
      }
    }
  })
)

const Sqlite = Migrated.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))

const services = Inbox.layer.pipe(
  Layer.provideMerge(ClassifierFake),
  Layer.provideMerge(Store.layer),
  Layer.provideMerge(TelegramFake),
  Layer.provideMerge(Attachments.layerMemory),
  Layer.provideMerge(Sqlite),
  Layer.provideMerge(Layer.succeed(Backend, "fake")),
  Layer.provideMerge(
    Layer.succeed(Secrets, Secrets.of({ agentToken: Effect.succeed(TOKEN), webhookSecret: Effect.succeed("hook") }))
  ),
  Layer.provideMerge(Layer.succeed(Settings, Settings.of({ profile, origin: "https://inbox.acme.test" }))),
  Layer.provideMerge(AuthPolicy.custom((request) => Effect.succeed(request.headers.cookie === "session=owner")))
)

const runtime = ManagedRuntime.make(services)
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof services>>) => runtime.runPromise(effect)

// The HTTP handler shares the runtime's services, so both see one database.
const { handler } = HttpRouter.toWebHandler(
  ApiLive.pipe(Layer.provide(Layer.succeedContext(await runtime.context())), Layer.provide(HttpServer.layerServices)),
  { disableLogger: true }
)

const eml = (fields: { from: string; subject: string; body: string; headers?: string }) =>
  new TextEncoder().encode(
    `From: ${fields.from}\r\nTo: bugs@acme.test\r\nSubject: ${fields.subject}\r\nMessage-ID: <${crypto.randomUUID()}@test>\r\n${
      fields.headers ?? ""
    }Content-Type: text/plain\r\n\r\n${fields.body}\r\n`
  ).buffer as ArrayBuffer

const api = (path: string, init: RequestInit & { token?: string | null; cookie?: string } = {}) =>
  handler(
    new Request(`https://inbox.acme.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
        ...(init.cookie ? { cookie: init.cookie } : {})
      }
    })
  )

describe("inbox", () => {
  test("new mail is stored, triaged and carded", async () => {
    await run(Effect.flatMap(Inbox, (inbox) => inbox.receive(eml({ from: "pat@shop.test", subject: "Invoice total wrong", body: "The total is off by $2." }), null)))
    const threads = await (await api("/api/threads")).json()
    expect(threads.threads).toHaveLength(1)
    expect(threads.threads[0]).toMatchObject({ subject: "Invoice total wrong", status: "queued", category: "billing" })
    expect(sent.at(-1)).toEqual({ status: "queued" })
  })

  test("bulk mail is filed without a card", async () => {
    const before = sent.length
    await run(Effect.flatMap(Inbox, (inbox) =>
      inbox.receive(eml({ from: "news@vendor.test", subject: "Our news", body: "Hi", headers: "List-Unsubscribe: <mailto:x@y>\r\n" }), null)))
    expect(sent.length).toBe(before)
    const ignored = await (await api("/api/threads?view=ignored")).json()
    expect(ignored.threads.map((t: { subject: string }) => t.subject)).toContain("Our news")
  })

  test("a reply lands on its thread as a follow-up", async () => {
    await run(Effect.flatMap(Inbox, (inbox) => inbox.receive(eml({ from: "pat@shop.test", subject: "Re: Invoice total wrong", body: "Still wrong" }), null)))
    expect(sent.at(-1)).toEqual({ status: "queued", as: "followup" })
    const threads = await (await api("/api/threads")).json()
    expect(threads.threads).toHaveLength(1)
  })

  test("repeat notices on an ignored thread are triaged, not carded as follow-ups", async () => {
    verdicts.set("Sensitive changes made", "ignore")
    const notice = () => eml({ from: "noreply@crm.test", subject: "Sensitive changes made", body: "A field changed." })
    await run(Effect.flatMap(Inbox, (inbox) => inbox.receive(notice(), null)))
    const before = sent.length
    await run(Effect.flatMap(Inbox, (inbox) => inbox.receive(notice(), null)))
    expect(sent.length).toBe(before)
    const ignored = await (await api("/api/threads?view=ignored")).json()
    expect(ignored.threads.filter((t: { subject: string }) => t.subject === "Sensitive changes made")).toHaveLength(2)
  })
})

describe("api auth", () => {
  test("health and config are public", async () => {
    expect((await api("/healthz", { token: null })).status).toBe(200)
    const config = await (await api("/api/config", { token: null })).json()
    expect(config).toMatchObject({ owner: "Sam", signIn: { label: "Sign in to Acme" } })
  })

  test("the inbox needs the owner", async () => {
    expect((await api("/api/threads", { token: null })).status).toBe(401)
    expect((await api("/api/threads", { token: "wrong" })).status).toBe(401)
    expect((await api("/api/threads", { token: null, cookie: "session=owner" })).status).toBe(200)
  })

  test("the agent endpoints need the bearer, not the cookie", async () => {
    expect((await api("/queue?status=queued", { token: null, cookie: "session=owner" })).status).toBe(401)
    const queued = await (await api("/queue?status=queued&limit=5")).json()
    expect(queued.reports[0].followups).toContain("Still wrong")
  })

  test("the agent's patch writes the result and sends its card", async () => {
    const [report] = (await (await api("/queue?status=queued")).json()).reports
    const res = await api(`/report/${encodeURIComponent(report.id)}`, {
      method: "POST",
      body: JSON.stringify({ status: "done", outcome: "pr_opened", pr_url: "https://github.com/acme/billing/pull/1" })
    })
    expect(await res.json()).toEqual({ ok: true, notified: true })
    expect(sent.at(-1)).toEqual({ status: "done" })
  })

  test("a thread's events read back in order", async () => {
    const [thread] = (await (await api("/api/threads")).json()).threads
    const body = await (await api(`/api/threads/${thread.short_id}`)).json()
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(["received", "status", "email", "status"])
    expect((await api("/api/threads/ffffffff")).status).toBe(404)
  })

  test("attachments are scoped to their report", async () => {
    const [thread] = (await (await api("/api/threads")).json()).threads
    expect((await api(`/a/${thread.short_id}?key=${encodeURIComponent("someone-else/raw.eml")}`)).status).toBe(404)
    const raw = await api(`/a/${thread.short_id}?key=${encodeURIComponent(`${encodeURIComponent(thread.id)}/raw.eml`)}`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain("The total is off")
  })
})
