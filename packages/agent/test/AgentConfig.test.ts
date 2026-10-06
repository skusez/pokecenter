import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { expandPath, load, parseRepos } from "../src/AgentConfig.ts"

describe("parseRepos", () => {
  test("name=path entries keep their names", () => {
    const repos = parseRepos("web=/code/web-app, api = /code/api ")
    expect(repos.byName).toEqual({ web: "/code/web-app", api: "/code/api" })
    expect(repos.fallback).toBe("/code/web-app")
  })

  test("a bare path is named after its folder, trailing slashes ignored", () => {
    expect(parseRepos("/code/web/,/code/api").byName).toEqual({ web: "/code/web/", api: "/code/api" })
  })

  test("the first entry is the fallback; empty entries are skipped", () => {
    const repos = parseRepos(",, /code/first ,web=/code/web,")
    expect(repos.fallback).toBe("/code/first")
    expect(repos.entries).toHaveLength(2)
  })

  test("empty means no repos and no fallback", () => {
    expect(parseRepos("")).toEqual({ byName: {}, fallback: undefined, entries: [] })
  })
})

describe("expandPath", () => {
  test("expands ~ and resolves relative paths", () => {
    expect(expandPath("~", "/home/me", "/work")).toBe("/home/me")
    expect(expandPath("~/x/y", "/home/me", "/work")).toBe("/home/me/x/y")
    expect(expandPath("./state", "/home/me", "/work")).toBe("/work/state")
    expect(expandPath("/abs", "/home/me", "/work")).toBe("/abs")
  })
})

const withEnv = (env: Record<string, string>) =>
  load.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))), Effect.result, Effect.runPromise)

describe("load", () => {
  test("reads the environment with defaults", async () => {
    const result = await withEnv({ POKECENTER_URL: "https://inbox.example.com/", POKECENTER_TOKEN: "t", REPOS: "web=/code/web" })
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    const config = result.success
    expect(config.url).toBe("https://inbox.example.com")
    expect(Redacted.value(config.token)).toBe("t")
    expect(config.repos.byName).toEqual({ web: "/code/web" })
    expect(config.maxInvestigationsPerRun).toBe(3)
    expect(config.opencodeBin).toBe("opencode")
    expect(Option.isNone(config.digestModel)).toBe(true)
    expect(config.worktreeRoot.endsWith("/.pokecenter-worktrees")).toBe(true)
    expect(config.stateDir).toBe(`${process.cwd()}/state`)
  })

  test("a missing URL or token is ConfigInvalid", async () => {
    const result = await withEnv({ POKECENTER_TOKEN: "t" })
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("ConfigInvalid")
  })

  test("a URL without a scheme is ConfigInvalid", async () => {
    const result = await withEnv({ POKECENTER_URL: "inbox.example.com", POKECENTER_TOKEN: "t" })
    expect(result._tag).toBe("Failure")
  })
})
