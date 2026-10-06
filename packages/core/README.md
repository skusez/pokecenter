# @skusez/pokecenter

The shared core of [pokecenter](https://github.com/skusez/pokecenter):

- `Profile`: one inbox's configuration (`Profile.define`)
- `Domain`: report, event and decision schemas
- `Mail`: MIME parsing, forward-as-attachment unwrapping, bulk detection, signature-image filtering, threading
- `Triage`: the questions sent to the decision models, and how their answers become a decision
- `Api`: the HTTP API definition shared by the worker, the agent and the UI

Runs anywhere: Workers, Bun, Node, the browser. Needs `effect` 4.
