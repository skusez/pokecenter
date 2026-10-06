import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { parseRepos } from "../src/AgentConfig.ts"
import { allAttachmentsOf, followUpsOf, notesOf } from "../src/Client.ts"
import { missingRepos } from "../src/Doctor.ts"
import { findingsOf, repoFor, safeFilename } from "../src/Investigator.ts"
import { profile, report } from "./fixtures.ts"

const repo = (repos: string, category: string | null) =>
  Effect.runSync(Effect.result(repoFor(profile, parseRepos(repos), category)))

describe("repoFor", () => {
  test("a category's repo by name", () => {
    expect(Result.getOrThrow(repo("first=/code/first,web=/code/web", "web"))).toBe("/code/web")
  })

  test("a category without a repo, or an unknown one, goes to the first entry", () => {
    expect(Result.getOrThrow(repo("first=/code/first,web=/code/web", "billing"))).toBe("/code/first")
    expect(Result.getOrThrow(repo("first=/code/first", "no-such-category"))).toBe("/code/first")
    expect(Result.getOrThrow(repo("first=/code/first", null))).toBe("/code/first")
  })

  test("a named repo with no checkout is MissingRepo", () => {
    const result = repo("web=/code/web", "mobile")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("MissingRepo")
      expect(result.failure.message).toContain("add mobile-app=<path> to REPOS")
    }
  })

  test("no repos at all is MissingRepo", () => {
    expect(Result.isFailure(repo("", "billing"))).toBe(true)
  })
})

test("missingRepos lists categories whose repo has no REPOS entry", () => {
  expect(missingRepos(profile, parseRepos("web=/code/web"))).toEqual([{ category: "mobile", repo: "mobile-app" }])
  expect(missingRepos(profile, parseRepos("web=/a,mobile-app=/b"))).toEqual([])
})

test("safeFilename keeps attachments inside their directory", () => {
  expect(safeFilename("../../etc/passwd", 0)).toBe("0-passwd")
  expect(safeFilename("..\\evil shot.png", 1)).toBe("1-evil shot.png")
  expect(safeFilename(".hidden", 2)).toBe("2-hidden")
  expect(safeFilename("", 3)).toBe("3-attachment")
  expect(safeFilename("screen:shot?.png", 4)).toBe("4-screen_shot_.png")
})

test("findingsOf joins what a thread shows", () => {
  expect(
    findingsOf({
      outcome: "pr_opened",
      headline: "Page size",
      findings: "The caller passes none.",
      files: [],
      branch: "inbox/AB12",
      pr_url: null,
      refused_instructions: "deploy to production",
      questions: "Is 50 right?"
    })
  ).toBe("Page size\n\nThe caller passes none.\n\n❓ Needs your call: Is 50 right?\n\n\n⚠️ Email also asked: deploy to production")
})

describe("report JSON columns", () => {
  const shot = { key: "a", filename: "a.png", mimeType: "image/png" }
  const r = report({
    attachments: JSON.stringify([shot]),
    notes: JSON.stringify([{ text: "see", attachments: [{ ...shot, key: "b" }] }]),
    followups: JSON.stringify([{ from: "x", subject: "y", body: "z", received_at: "t", attachments: [{ ...shot, key: "c" }] }])
  })

  test("decode, and collect every attachment", () => {
    expect(notesOf(r)[0]?.text).toBe("see")
    expect(followUpsOf(r)[0]?.body).toBe("z")
    expect(allAttachmentsOf(r).map((a) => a.key)).toEqual(["a", "b", "c"])
  })

  test("null or malformed reads as empty", () => {
    expect(notesOf(report())).toEqual([])
    expect(followUpsOf(report({ followups: "{oops" }))).toEqual([])
    expect(allAttachmentsOf(report({ attachments: "[{\"wrong\":1}]" }))).toEqual([])
  })
})
