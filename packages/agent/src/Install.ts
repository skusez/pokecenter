import { Console, Effect, FileSystem, Path } from "effect"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { AgentConfig } from "./AgentConfig.ts"
import { ConfigPath } from "./CurrentProfile.ts"
import { CurrentProfile } from "./CurrentProfile.ts"
import { ConfigInvalid } from "./Errors.ts"

/** The absolute paths and environment a scheduled job runs with. */
export interface Machine {
  /** From the profile's name: `Example Co` → `example-co`. */
  readonly slug: string
  readonly bun: string
  /** This package's `src/bin.ts`. */
  readonly bin: string
  readonly profilePath: string
  readonly cwd: string
  readonly path: string
  readonly home: string
  readonly stateDir: string
}

export interface Job {
  readonly name: "triage" | "investigate"
  readonly description: string
  readonly args: ReadonlyArray<string>
  readonly intervalSeconds: number
}

export interface UnitFile {
  readonly path: string
  readonly contents: string
}

export interface Plan {
  readonly files: ReadonlyArray<UnitFile>
  /** What to run to start the jobs. Printed, never run. */
  readonly load: ReadonlyArray<string>
}

export const slugOf = (name: string): string =>
  name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "inbox"

/**
 * Two jobs, because an investigation can run for 45 minutes and sharing a job
 * would hold every digest behind it.
 */
export const jobsFor = (machine: Machine): ReadonlyArray<Job> => [
  {
    name: "triage",
    description: "retry triage and write digests",
    args: [machine.bin, "run", "--triage-only", "--config", machine.profilePath],
    intervalSeconds: 5 * 60
  },
  {
    name: "investigate",
    description: "investigate queued reports",
    args: [machine.bin, "run", "--investigate-only", "--config", machine.profilePath],
    intervalSeconds: 10 * 60
  }
]

export const launchdLabel = (machine: Machine, job: Job): string => `dev.pokecenter.${machine.slug}.${job.name}`
export const systemdUnit = (machine: Machine, job: Job): string => `pokecenter-${machine.slug}-${job.name}`

const xml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const renderPlist = (machine: Machine, job: Job): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(launchdLabel(machine, job))}</string>

  <!-- ${xml(job.description)} -->
  <key>ProgramArguments</key>
  <array>
${[machine.bun, ...job.args].map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>

  <key>WorkingDirectory</key>
  <string>${xml(machine.cwd)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- git and gh for the PR, bun, and opencode: this shell's PATH when installed. -->
    <key>PATH</key>
    <string>${xml(machine.path)}</string>
    <key>HOME</key>
    <string>${xml(machine.home)}</string>
    <!-- launchd sets the working directory but not PWD, and opencode resolves
         its project from PWD. Without this a run anchors to the wrong repo. -->
    <key>PWD</key>
    <string>${xml(machine.cwd)}</string>
  </dict>

  <key>StartInterval</key>
  <integer>${job.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${xml(`${machine.stateDir}/${job.name}.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${machine.stateDir}/${job.name}.err.log`)}</string>
</dict>
</plist>
`

/** systemd splits ExecStart on whitespace; quote what would split. */
const systemdArg = (arg: string): string =>
  /[\s"\\]/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"` : arg

const systemdEnv = (key: string, value: string): string => `Environment=${systemdArg(`${key}=${value}`)}`

export const renderService = (machine: Machine, job: Job): string =>
  `[Unit]
Description=pokecenter ${machine.slug}: ${job.description}

[Service]
Type=oneshot
WorkingDirectory=${machine.cwd}
${systemdEnv("PATH", machine.path)}
${systemdEnv("HOME", machine.home)}
# opencode resolves its project from PWD, not the working directory.
${systemdEnv("PWD", machine.cwd)}
ExecStart=${[machine.bun, ...job.args].map(systemdArg).join(" ")}
Nice=10
IOSchedulingClass=idle
StandardOutput=append:${machine.stateDir}/${job.name}.log
StandardError=append:${machine.stateDir}/${job.name}.err.log
`

export const renderTimer = (machine: Machine, job: Job): string =>
  `[Unit]
Description=pokecenter ${machine.slug}: ${job.description} every ${job.intervalSeconds / 60} minutes

[Timer]
OnBootSec=${job.intervalSeconds / 60}min
OnUnitInactiveSec=${job.intervalSeconds / 60}min
Unit=${systemdUnit(machine, job)}.service

[Install]
WantedBy=timers.target
`

export const planFor = (platform: NodeJS.Platform, machine: Machine): Plan | null => {
  const jobs = jobsFor(machine)
  if (platform === "darwin") {
    const files = jobs.map((job) => ({
      path: `${machine.home}/Library/LaunchAgents/${launchdLabel(machine, job)}.plist`,
      contents: renderPlist(machine, job)
    }))
    return { files, load: files.map((f) => `launchctl bootstrap gui/$(id -u) ${systemdArg(f.path)}`) }
  }
  if (platform === "linux") {
    const dir = `${machine.home}/.config/systemd/user`
    const files = jobs.flatMap((job) => [
      { path: `${dir}/${systemdUnit(machine, job)}.service`, contents: renderService(machine, job) },
      { path: `${dir}/${systemdUnit(machine, job)}.timer`, contents: renderTimer(machine, job) }
    ])
    return {
      files,
      load: [
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${jobs.map((job) => `${systemdUnit(machine, job)}.timer`).join(" ")}`
      ]
    }
  }
  return null
}

/** This machine, as the jobs should see it. */
export const thisMachine = Effect.gen(function*() {
  const config = yield* AgentConfig
  const profile = yield* CurrentProfile
  const profilePath = yield* ConfigPath
  const path = yield* Path.Path
  return {
    slug: slugOf(profile.name),
    bun: process.execPath,
    bin: fileURLToPath(new URL("./bin.ts", import.meta.url)),
    profilePath: path.resolve(profilePath),
    cwd: process.cwd(),
    path: jobPath(process.env.PATH),
    home: process.env.HOME ?? homedir(),
    stateDir: config.stateDir
  } satisfies Machine
})

export const install = Effect.fn("install")(function*(options: { readonly dryRun: boolean }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const machine = yield* thisMachine
  const plan = planFor(process.platform, machine)
  if (!plan) {
    return yield* new ConfigInvalid({
      message: `install supports macOS (launchd) and Linux (systemd), not ${process.platform}`
    })
  }

  for (const file of plan.files) {
    if (options.dryRun) {
      yield* Console.log(`# ${file.path}\n${file.contents}`)
    } else {
      yield* fs.makeDirectory(path.dirname(file.path), { recursive: true })
      yield* fs.writeFileString(file.path, file.contents)
      yield* Console.log(`wrote ${file.path}`)
    }
  }
  if (!options.dryRun) yield* fs.makeDirectory(machine.stateDir, { recursive: true })

  yield* Console.log(`\n${options.dryRun ? "Nothing written (--dry-run). " : ""}To start the jobs, run:`)
  for (const command of plan.load) yield* Console.log(`  ${command}`)
})

/**
 * This shell's PATH, minus what only made sense in it: a package runner's
 * temporary directory (bunx, npx) and project node_modules/.bin entries.
 */
export const jobPath = (path: string | undefined): string =>
  [...new Set((path ?? "/usr/local/bin:/usr/bin:/bin").split(":"))]
    .filter((entry) => entry && !/\/bunx-|\/_npx\/|\/node_modules\/\.bin$/.test(entry))
    .join(":")
