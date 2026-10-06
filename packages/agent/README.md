# @skusez/pokecenter-agent

The `pokecenter` CLI: the local half of [pokecenter](https://github.com/skusez/pokecenter). It runs on a machine that has your repos checked out and [opencode](https://opencode.ai) v2 signed in to a model provider.

```bash
pokecenter doctor             # check config, the worker, opencode, git, gh and every repo
pokecenter run                # retry triage, write digests, investigate queued reports
pokecenter install            # write launchd jobs (macOS) or systemd timers (Linux)
pokecenter replay --backend clef   # triage past mail dry and compare with where it ended up
pokecenter webhook register   # point the Telegram bot at the worker
pokecenter status
```

It reads `pokecenter.config.ts` from the working directory (or `--config`) and these environment variables:
- `POKECENTER_URL` and `POKECENTER_TOKEN`: the worker and its agent token
- `REPOS`: `name=path` for each repo a category names
- `OPENCODE_BIN`: defaults to `opencode`
- `DIGEST_MODEL` and `INVESTIGATE_MODEL`: optional
- `MAX_INVESTIGATIONS_PER_RUN`
- `WORKTREE_ROOT`

Investigations run in a fresh git worktree per report and end in a draft PR, an answer, or a diagnosis. The agent never merges, pushes to main or deploys. Put your own `.opencode/opencode.json` in the project to give the investigator MCP servers or other permissions.
