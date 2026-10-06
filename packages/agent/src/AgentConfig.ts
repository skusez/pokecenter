import { Config, Context, Effect, Layer, Option, type Redacted } from "effect"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ConfigInvalid } from "./Errors.ts"

export interface Repos {
  /** Checkout path by repo name, as a profile's categories name them. */
  readonly byName: Readonly<Record<string, string>>
  /** The first entry: where a report whose category names no repo is investigated. */
  readonly fallback: string | undefined
  readonly entries: ReadonlyArray<readonly [name: string, path: string]>
}

/**
 * `REPOS` is a comma-separated list of `name=path`, the name being the repo a
 * profile category names (`web=/Users/me/code/web-app`). A bare path is named
 * after its folder, which fits most checkouts but not one cloned under another
 * name. The first entry is where a report of unknown category is investigated.
 */
export const parseRepos = (value: string): Repos => {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): readonly [string, string] => {
      const at = entry.indexOf("=")
      return at === -1
        ? [entry.replace(/\/+$/, "").split("/").pop()!, entry]
        : [entry.slice(0, at).trim(), entry.slice(at + 1).trim()]
    })
  return { byName: Object.fromEntries(entries), fallback: entries[0]?.[1], entries }
}

/** `~` and `~/x` to the home directory; anything else resolved against the working directory. */
export const expandPath = (path: string, home: string = homedir(), cwd: string = process.cwd()): string =>
  path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(cwd, path)

export interface AgentConfigShape {
  /** The worker's base URL, without a trailing slash. */
  readonly url: string
  readonly token: Redacted.Redacted<string>
  readonly repos: Repos
  /** `provider/model#variant`; the variant is the reasoning effort. None: the opencode agent's own model. */
  readonly digestModel: Option.Option<string>
  readonly investigateModel: Option.Option<string>
  readonly maxInvestigationsPerRun: number
  readonly worktreeRoot: string
  readonly opencodeBin: string
  /** Absolute. Attachments and the digest workspace live here. */
  readonly stateDir: string
}

const config = Config.all({
  url: Config.String("POKECENTER_URL"),
  token: Config.Redacted("POKECENTER_TOKEN"),
  repos: Config.String("REPOS").pipe(Config.withDefault("")),
  digestModel: Config.option(Config.NonEmptyString("DIGEST_MODEL")),
  investigateModel: Config.option(Config.NonEmptyString("INVESTIGATE_MODEL")),
  maxInvestigationsPerRun: Config.Int("MAX_INVESTIGATIONS_PER_RUN").pipe(Config.withDefault(3)),
  worktreeRoot: Config.String("WORKTREE_ROOT").pipe(Config.withDefault("~/.pokecenter-worktrees")),
  opencodeBin: Config.String("OPENCODE_BIN").pipe(Config.withDefault("opencode")),
  stateDir: Config.String("POKECENTER_STATE_DIR").pipe(Config.withDefault("./state"))
})

/** Reads the environment (Bun loads `.env` from the working directory itself). */
export const load: Effect.Effect<AgentConfigShape, ConfigInvalid> = Effect.gen(function*() {
  const raw = yield* config.pipe(
    Effect.mapError((error) =>
      new ConfigInvalid({ message: `${error.message}. Set it in the environment or in .env where the agent runs.` })
    )
  )
  if (!/^https?:\/\//.test(raw.url)) {
    return yield* new ConfigInvalid({ message: `POKECENTER_URL must be an http(s) URL, got "${raw.url}"` })
  }
  const parsed = parseRepos(raw.repos)
  const entries = parsed.entries.map(([name, path]) => [name, expandPath(path)] as const)
  return {
    url: raw.url.replace(/\/+$/, ""),
    token: raw.token,
    repos: { byName: Object.fromEntries(entries), fallback: entries[0]?.[1], entries },
    digestModel: raw.digestModel,
    investigateModel: raw.investigateModel,
    maxInvestigationsPerRun: raw.maxInvestigationsPerRun,
    worktreeRoot: expandPath(raw.worktreeRoot),
    opencodeBin: raw.opencodeBin,
    stateDir: expandPath(raw.stateDir)
  }
})

export class AgentConfig extends Context.Service<AgentConfig, AgentConfigShape>()("@skusez/pokecenter-agent/AgentConfig") {
  static readonly layer = Layer.effect(AgentConfig, load)
}
