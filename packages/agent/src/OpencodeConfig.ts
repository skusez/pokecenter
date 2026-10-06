import { Effect, FileSystem, Path } from "effect"
import { fileURLToPath } from "node:url"

/**
 * The opencode config shipped with this package: `digest` and `investigate`
 * agents with their deny rules. At the package root, beside `src/` and `dist/`.
 */
const packaged = [fileURLToPath(new URL("../opencode.json", import.meta.url))]

/**
 * The opencode config runs use: the instance project's own
 * `.opencode/opencode.json` (where it adds MCP servers or changes a rule),
 * else the package default.
 */
export const resolve = Effect.fn("OpencodeConfig.resolve")(function*(projectDir: string = process.cwd()) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidates = [path.join(projectDir, ".opencode", "opencode.json"), ...packaged]
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return candidate
  }
  return yield* Effect.die(new Error(`no opencode config found; looked in ${candidates.join(", ")}`))
})

/**
 * Writes the config into `dir/.opencode/opencode.json`. opencode resolves
 * agents from the project at its working directory; a directory without this
 * defines no `investigate` or `digest` agent, and opencode falls back to
 * whichever project does, reading that project's source instead.
 */
export const install = Effect.fn("OpencodeConfig.install")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = yield* resolve()
  yield* fs.makeDirectory(path.join(dir, ".opencode"), { recursive: true })
  yield* fs.copyFile(source, path.join(dir, ".opencode", "opencode.json"))
})
