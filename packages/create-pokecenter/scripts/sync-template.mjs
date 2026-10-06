// Copies examples/basic into template/, with workspace and catalog versions
// replaced by the published ones, so the scaffold matches the example exactly.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const root = new URL("../../../", import.meta.url)
const here = new URL("../", import.meta.url)
const template = new URL("template/", here)
const catalog = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).workspaces.catalog
const version = (name) => JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, root), "utf8")).version

rmSync(template, { recursive: true, force: true })
cpSync(new URL("examples/basic/", root), template, {
  recursive: true,
  filter: (src) => !/node_modules|\.alchemy|\/state$|\.env$/.test(src)
})

const pkg = JSON.parse(readFileSync(new URL("package.json", template), "utf8"))
const ours = { "@skusez/pokecenter": "core", "@skusez/pokecenter-agent": "agent", "@skusez/pokecenter-cloudflare": "cloudflare" }
for (const [dep, spec] of Object.entries(pkg.dependencies)) {
  if (spec === "workspace:*") pkg.dependencies[dep] = `^${version(ours[dep])}`
  else if (spec === "catalog:") pkg.dependencies[dep] = catalog[dep]
}
pkg.name = "my-inbox"
writeFileSync(new URL("package.json", template), JSON.stringify(pkg, null, 2) + "\n")
// npm drops .gitignore from packages; it is restored on scaffold.
cpSync(new URL(".gitignore", template), new URL("gitignore", template))
rmSync(new URL(".gitignore", template))
writeFileSync(new URL("tsconfig.json", template), JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ES2023", "DOM"],
    types: ["bun-types"], strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true
  },
  include: ["*.ts"]
}, null, 2) + "\n")
pkg.devDependencies = { "@types/bun": "latest", typescript: catalog.typescript }
writeFileSync(new URL("package.json", template), JSON.stringify(pkg, null, 2) + "\n")
console.log("template synced")
