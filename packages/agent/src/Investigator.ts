import { Investigation, type QueuedReport, type StoredAttachment } from "@skusez/pokecenter/Domain"
import { categoryOf, type Profile } from "@skusez/pokecenter/Profile"
import { Context, Effect, FileSystem, Layer, Path, type PlatformError } from "effect"
import { AgentConfig, type Repos } from "./AgentConfig.ts"
import { allAttachmentsOf, type ApiError, Client, followUpsOf, notesOf } from "./Client.ts"
import { CurrentProfile } from "./CurrentProfile.ts"
import { type GitFailed, MissingRepo, type OpencodeError } from "./Errors.ts"
import { decodeAnswer, Opencode } from "./Opencode.ts"
import * as Prompts from "./Prompts.ts"
import { Worktrees } from "./Worktrees.ts"

/** The checkout a category's code lives in. A category naming no repo: the first entry of `REPOS`. */
export const repoFor = (profile: Profile, repos: Repos, value: string | null): Effect.Effect<string, MissingRepo> => {
  const category = categoryOf(profile, value)
  const name = profile.categories[category]?.repo ?? null
  const repo = name ? repos.byName[name] : repos.fallback
  return repo
    ? Effect.succeed(repo)
    : Effect.fail(
      new MissingRepo({
        category,
        repo: name,
        message: name
          ? `no checkout for ${name} (category ${category}): add ${name}=<path> to REPOS`
          : "REPOS is empty: set it to at least one name=path"
      })
    )
}

/** A filename from an email, made safe to write: no directories, no dot-files. */
export const safeFilename = (name: string, index: number): string => {
  const base = name.split(/[\\/]/).pop()?.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "") ?? ""
  return `${index}-${base || "attachment"}`
}

/** One line per outcome, the way a report's findings read in the thread. */
export const findingsOf = (result: Investigation): string =>
  [
    result.headline,
    result.findings,
    result.questions ? `❓ Needs your call: ${result.questions}` : "",
    result.refused_instructions ? `\n⚠️ Email also asked: ${result.refused_instructions}` : ""
  ]
    .filter(Boolean)
    .join("\n\n")

const decodeInvestigation = decodeAnswer(Investigation)

export type InvestigateError = MissingRepo | GitFailed | OpencodeError | ApiError | PlatformError.PlatformError

export class Investigator extends Context.Service<Investigator, {
  /**
   * Investigates one report in a worktree of its category's repo. `onLine`
   * receives opencode's progress as it happens.
   */
  investigate(report: QueuedReport, onLine?: (line: string) => Effect.Effect<void>): Effect.Effect<Investigation, InvestigateError>
}>()("@skusez/pokecenter-agent/Investigator") {
  static readonly layer = Layer.effect(
    Investigator,
    Effect.gen(function*() {
      const config = yield* AgentConfig
      const profile = yield* CurrentProfile
      const client = yield* Client
      const opencode = yield* Opencode
      const worktrees = yield* Worktrees
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      /**
       * Materialises a report's attachments on disk: the email's own, any the
       * owner attached to a note, and any on later mail. opencode takes them
       * by absolute path.
       */
      const fetchAttachments = Effect.fn("Investigator.fetchAttachments")(function*(report: QueuedReport) {
        const files: ReadonlyArray<StoredAttachment> = allAttachmentsOf(report)
        const dir = path.join(config.stateDir, "attachments", encodeURIComponent(report.id))
        yield* fs.makeDirectory(dir, { recursive: true })
        return yield* Effect.forEach(files, (file, index) =>
          Effect.gen(function*() {
            const bytes = yield* client.agent.attachment({ query: { key: file.key } })
            const target = path.join(dir, safeFilename(file.filename, index))
            yield* fs.writeFile(target, bytes)
            return target
          }), { concurrency: 4 })
      })

      const investigate = Effect.fn("Investigator.investigate")(function*(
        report: QueuedReport,
        onLine?: (line: string) => Effect.Effect<void>
      ) {
        const repo = yield* repoFor(profile, config.repos, report.category)
        const files = yield* fetchAttachments(report)
        const related = yield* client.agent.related({ query: { report: report.id } }).pipe(
          Effect.map((r) => r.related),
          Effect.orElseSucceed(() => [])
        )
        const worktree = yield* worktrees.acquire(repo, report.short_id)

        const answer = yield* opencode.run({
          prompt: Prompts.investigatorPrompt(profile, {
            subject: report.subject,
            sender: report.from_addr,
            summary: report.reason ?? "",
            category: categoryOf(profile, report.category),
            suspicious: report.suspicious === 1,
            body: report.body,
            attachments: files.length,
            branch: worktree.branch,
            history: {
              notes: notesOf(report),
              findings: report.findings,
              prUrl: report.pr_url,
              mails: followUpsOf(report),
              related
            }
          }),
          agent: "investigate",
          model: config.investigateModel,
          timeout: "45 minutes",
          required: Prompts.INVESTIGATION_REQUIRED,
          shape: Prompts.investigationShape(profile),
          files,
          cwd: worktree.dir,
          // A second attempt would start over in a worktree the first may have
          // half-changed, and doubles the cost of a run that already took long.
          attempts: 1,
          onLine
        })
        const result = yield* decodeInvestigation({
          branch: null,
          pr_url: null,
          refused_instructions: null,
          questions: null,
          ...answer
        })
        return { ...result, branch: result.branch ?? worktree.branch }
      }, Effect.scoped)

      return Investigator.of({ investigate })
    })
  )
}
