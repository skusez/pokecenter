#!/usr/bin/env node
// Scaffolds a pokecenter inbox: copies the template and fills in the names.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline"

// Read answers as lines, so piped input works as well as a terminal.
const rl = createInterface({ input: stdin, terminal: false })
const lines = rl[Symbol.asyncIterator]()
const ask = async (question, fallback) => {
  stdout.write(`${question}${fallback ? ` (${fallback})` : ""}: `)
  const { done, value } = await lines.next()
  if (!stdin.isTTY) stdout.write("\n")
  return (done ? "" : value).trim() || fallback
}

const dir = resolve(process.argv[2] || (await ask("Directory", "my-inbox")))
if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${dir} is not empty.`)
  process.exit(1)
}
const name = await ask("Organisation or product name", "Acme")
const about = await ask(`What is the inbox for? "Support mail for …"`, `${name}'s software`)
const owner = await ask("Who handles mail that needs a person?", "the team")
const address = await ask("Address mail arrives at", "support@example.com")
const zone = await ask("Cloudflare zone it belongs to", address.split("@")[1])
const domain = await ask("Domain for the inbox UI", `inbox.${zone}`)
rl.close()

cpSync(new URL("./template/", import.meta.url), dir, { recursive: true })
renameSync(resolve(dir, "gitignore"), resolve(dir, ".gitignore"))

const edit = (file, pairs) => {
  const path = resolve(dir, file)
  let text = readFileSync(path, "utf8")
  for (const [from, to] of pairs) text = text.replaceAll(from, to)
  writeFileSync(path, text)
}
const stack = name.replace(/[^A-Za-z0-9]/g, "") + "Inbox"
edit("pokecenter.config.ts", [
  ['name: "Acme"', `name: ${JSON.stringify(name)}`],
  ['about: "Acme\'s invoicing app, which small businesses use"', `about: ${JSON.stringify(about)}`],
  ['owner: "Sam"', `owner: ${JSON.stringify(owner)}`],
  ['title: "Acme inbox"', `title: ${JSON.stringify(`${name} inbox`)}`]
])
edit("worker.ts", [
  ['"inbox.acme.example"', JSON.stringify(domain)],
  ['address: "support@acme.example", zone: "acme.example"', `address: ${JSON.stringify(address)}, zone: ${JSON.stringify(zone)}`]
])
edit("alchemy.run.ts", [['"AcmeInbox"', JSON.stringify(stack)]])
edit("package.json", [['"my-inbox"', JSON.stringify(dir.split("/").pop())]])

console.log(`
Created ${dir}. Next:

  cd ${dir}
  bun install
  cp .env.example .env    # fill in Cloudflare and Telegram
  # edit pokecenter.config.ts: your categories and the repos they live in
  # edit worker.ts: who may open the inbox (Cloudflare Access by default)
  bun run deploy          # prints url and agentToken for .env
  bunx pokecenter webhook register
  bunx pokecenter doctor
  bunx pokecenter install # runs the agent every few minutes
`)
