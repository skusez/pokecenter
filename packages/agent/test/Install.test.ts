import { describe, expect, test } from "bun:test"
import { jobPath, jobsFor, type Machine, planFor, renderPlist, renderService, renderTimer, slugOf } from "../src/Install.ts"

const machine: Machine = {
  slug: "example-co",
  bun: "/home/me/.bun/bin/bun",
  bin: "/opt/pokecenter/src/bin.ts",
  profilePath: "/home/me/My Inbox/pokecenter.config.ts",
  cwd: "/home/me/My Inbox",
  path: "/home/me/.bun/bin:/usr/bin:/bin",
  home: "/home/me",
  stateDir: "/home/me/My Inbox/state"
}
const [triage, investigate] = jobsFor(machine) as [ReturnType<typeof jobsFor>[number], ReturnType<typeof jobsFor>[number]]

test("slugOf", () => {
  expect(slugOf("Example Co")).toBe("example-co")
  expect(slugOf("  Ünïcode & Sons!! ")).toBe("unicode-sons")
  expect(slugOf("!!!")).toBe("inbox")
})

test("two jobs: triage every 5 minutes, investigate every 10", () => {
  expect(triage.args).toEqual([machine.bin, "run", "--triage-only", "--config", machine.profilePath])
  expect(triage.intervalSeconds).toBe(300)
  expect(investigate.args).toContain("--investigate-only")
  expect(investigate.intervalSeconds).toBe(600)
})

describe("launchd", () => {
  const plist = renderPlist(machine, triage)

  test("labels, arguments, interval and logs", () => {
    expect(plist).toContain("<string>dev.pokecenter.example-co.triage</string>")
    expect(plist).toContain(
      "    <string>/home/me/.bun/bin/bun</string>\n    <string>/opt/pokecenter/src/bin.ts</string>\n    <string>run</string>\n    <string>--triage-only</string>"
    )
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>300</integer>")
    expect(plist).toContain("<string>/home/me/My Inbox/state/triage.log</string>")
  })

  test("sets PWD, PATH and HOME for opencode", () => {
    expect(plist).toContain("<key>PWD</key>\n    <string>/home/me/My Inbox</string>")
    expect(plist).toContain("<key>PATH</key>\n    <string>/home/me/.bun/bin:/usr/bin:/bin</string>")
    expect(plist).toContain("<key>HOME</key>\n    <string>/home/me</string>")
  })

  test("escapes XML", () => {
    expect(renderPlist({ ...machine, cwd: "/a&b<c>" }, triage)).toContain("<string>/a&amp;b&lt;c&gt;</string>")
  })

  test("plan writes to LaunchAgents and prints bootstrap commands", () => {
    const plan = planFor("darwin", machine)!
    expect(plan.files.map((f) => f.path)).toEqual([
      "/home/me/Library/LaunchAgents/dev.pokecenter.example-co.triage.plist",
      "/home/me/Library/LaunchAgents/dev.pokecenter.example-co.investigate.plist"
    ])
    expect(plan.load[0]).toBe(
      "launchctl bootstrap gui/$(id -u) /home/me/Library/LaunchAgents/dev.pokecenter.example-co.triage.plist"
    )
  })
})

describe("systemd", () => {
  test("service quotes paths with spaces and sets PWD", () => {
    const service = renderService(machine, investigate)
    expect(service).toContain("Type=oneshot")
    expect(service).toContain(
      `ExecStart=/home/me/.bun/bin/bun /opt/pokecenter/src/bin.ts run --investigate-only --config "/home/me/My Inbox/pokecenter.config.ts"`
    )
    expect(service).toContain(`Environment="PWD=/home/me/My Inbox"`)
    expect(service).toContain("Environment=PATH=/home/me/.bun/bin:/usr/bin:/bin")
    expect(service).toContain("StandardOutput=append:/home/me/My Inbox/state/investigate.log")
  })

  test("timer runs the service on its interval", () => {
    const timer = renderTimer(machine, triage)
    expect(timer).toContain("OnUnitInactiveSec=5min")
    expect(timer).toContain("Unit=pokecenter-example-co-triage.service")
    expect(timer).toContain("WantedBy=timers.target")
  })

  test("plan writes user units and prints enable commands", () => {
    const plan = planFor("linux", machine)!
    expect(plan.files.map((f) => f.path)).toEqual([
      "/home/me/.config/systemd/user/pokecenter-example-co-triage.service",
      "/home/me/.config/systemd/user/pokecenter-example-co-triage.timer",
      "/home/me/.config/systemd/user/pokecenter-example-co-investigate.service",
      "/home/me/.config/systemd/user/pokecenter-example-co-investigate.timer"
    ])
    expect(plan.load).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now pokecenter-example-co-triage.timer pokecenter-example-co-investigate.timer"
    ])
  })
})

test("other platforms have no plan", () => {
  expect(planFor("win32", machine)).toBeNull()
})

test("the job PATH drops temporary and project-local entries", () => {
  expect(
    jobPath("/var/folders/x/T/bunx-501-pokecenter@latest/node_modules/.bin:/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/usr/bin")
  ).toBe("/opt/homebrew/bin:/usr/bin")
})
