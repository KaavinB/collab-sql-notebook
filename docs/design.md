# Design decisions

The choices that shape this project, what each one rejected, and what it costs. They're grouped by layer. The [README](../README.md) has the overview and the measured results.

## Real-time collaboration

**A CRDT (Yjs), not operational transformation.** Every cell's text, the list of cells and each cell's settings live in one Yjs document. Two people editing the same cell, or one editing while disconnected, merge without a central transform step. *Rejected:* OT, which needs the server to order and transform every operation, and makes offline editing much harder. *Cost:* the document keeps tombstones for deleted content, so its history grows; compaction (below) bounds the stored form.

**Our own sync server, on the standard wire protocol.** `apps/sync` is a small Node server built on `ws` that speaks the standard y-protocols sync and awareness messages, so the browser uses y-websocket's off-the-shelf provider. Every connection needs a short-lived signed ticket from the API. Membership is rechecked in Postgres on every connect. Viewers' updates are dropped on the server, and cursor and presence messages are validated against their exact wire shape before they're relayed. *Rejected:* Hocuspocus. *Why:* the parts worth understanding are ours: room lifecycle, auth on connect, read-only viewers, persistence and awareness cleanup. *Cost:* one sync instance, because rooms live in memory. Running several would need routing by notebook.

**Persistence: an update log plus compaction.** The sync server appends incoming updates to Postgres in short batches, and periodically compacts a notebook's log into one snapshot. A room that empties is flushed, compacted and unloaded; one that comes back loads the snapshot plus the newer log. *Rejected:* saving whole-document snapshots from the client, where the last writer wins and two tabs overwrite each other.

**Server-side writes go through Postgres NOTIFY.** When a query run or an AI request starts or finishes, the API sends a NOTIFY. The sync server writes the run state, or the AI's suggestion and presence, into the document, so everyone sees it even if the person who started it has left. Missed events are reconciled from the API's tables when a room loads.

**"Unsynced" means the server hasn't confirmed your edits.** After you type, the browser sends one sync step 1 to the server. The server answers each socket's messages in order, so its reply confirms every edit sent before it. Edits that stay unconfirmed for 3 s, or any edits while offline, show as Unsynced, and closing the tab asks first. Offline edits count as sent only once the reconnect handshake has carried them. *Rejected:* trusting y-websocket's 30-second watchdog, which let a half-open socket hide unsent edits. *Cost:* the server encodes one state diff per typing client, at most every 300 ms.

## Queries

**Queries run on the API server, in a pool of separate processes.** Each DuckDB query runs in a worker process. Its environment holds no secrets, and it runs under a timeout, a row cap, DuckDB's own memory limit and, on Linux, an OS memory limit (RLIMIT_DATA). A worker past its timeout is killed and replaced. *Rejected:* DuckDB inside the API process, where a runaway query can't be stopped; DuckDB in the browser, where results aren't shared.

**One execution per cell, shared by everyone.** A Postgres lock row per cell turns two people pressing Run at once into one execution. The second person joins the first run and gets the same result, which the sync server announces to everyone.

**Layered query safety, tested against an attack corpus.** The layers:
- sqlglot allows exactly one SELECT;
- the database is opened read-only;
- DuckDB's external file and network access is off and its settings are locked;
- functions, views and built-in macros that reveal server settings or paths are blocked, as are invisible characters that DuckDB reads as whitespace;
- server paths are scrubbed from every error and result.

A corpus of 157 escape and resource attacks runs through the real validator and worker pool. 138 must be refused or stopped; 19 are shown to be harmless, each with its reason. Guard tests fail if a DuckDB upgrade adds any table function, macro or internal view nobody has reviewed. *Rejected:* an OS sandbox (Landlock and seccomp, or a namespace jail) for now. *Cost:* the claim is "DuckDB's lockdown plus process limits, tested", not an OS jail. If a DuckDB bug bypassed its own lockdown, a worker could read what the API's OS user can read.

**Results live in Postgres, not in the document.** The document holds only a pointer to the latest run. Results are kept per cell (the newest 3) and capped per notebook, so a large result never inflates sync traffic or the document's history.

## The AI collaborator

**The AI joins as a collaborator.** The browser asks the API. The API calls Claude, validates the answer and stores it as a suggestion. The sync server shows the AI's presence, cursor and suggestion to everyone. Anyone with edit rights can accept or reject it. Accepting is decided by the server first, then applied as that person's own edit, so their undo can revert it. A suggestion is never applied silently.

**Validate and repair.** The model gets the schema with sample values. Each suggested query is parsed, then planned with EXPLAIN on a worker. On an error the model tries again with the error, up to 2 retries. Every request is logged with its prompt, attempts, tokens and latency. Each notebook keeps its 500 most recent finished requests. *Cost:* limits are per user (20 requests per 5 minutes, 2 in flight) and per process (`AI_MAX_CONCURRENT`), and are held in memory per API process.

## Measuring it

**Convergence fuzz test, through our own server code.** Simulated clients edit the real notebook shape through the real Room and Postgres store, over fake sockets. The run includes random delivery order, drops, offline edits, reconnects, injected store failures, an unload, a crash and a restart. Every editor's replica, the server and a fresh load from Postgres must end identical. Viewers' edits must never appear, and a viewer must match the server except for the one known crash case (see the limitations below), which the test counts. Mid-run checkpoints catch relay bugs that a later reconnect would otherwise repair. *Rejected:* a pure-Yjs fuzz, which would mostly re-test Yjs.

**Latency: two real browsers plus headless load.** Two real browsers on one machine time a keystroke in one until it appears in the other's DOM, on one clock. For "many clients", headless Yjs clients join the same room and edit too.

**Load: a fixed threshold.** Editors are added in steps. The limit is the last step where p95 edit-to-remote-apply latency stays under 100 ms. If the load generator itself falls behind, the result is reported as inconclusive rather than as a limit.

**Text-to-SQL eval: BIRD plus our own questions.** BIRD dev is a seeded, difficulty-stratified subset, scored by execution accuracy as BIRD scores it, with 95% Wilson intervals. The 50 taxi questions were written by Codex, a model from another provider, so the Claude models aren't scored on questions Claude wrote. Each run records the code version, prompt settings and costs computed from list prices including prompt caching. Every report can be rebuilt from stored answers without calling a model.

## Known limitations

- **Local only.** Deployment is planned but not done. Signing in across separate web and API domains will need both on one registrable domain.
- **One process each** for the sync server and the API's in-memory limits. Scaling out needs routing by notebook.
- **No OS sandbox** for query workers (see above). On macOS, memory bombs are stopped only by the timeout kill.
- **Crash during the save window.** If the sync server crashes within 250 ms of writing run or AI state, a viewer can keep that state until they reload. A crash in the same window can also lose edits that were already confirmed but not yet saved.
- **The sync ticket travels in the WebSocket URL,** where a proxy could log it, and it is reusable for 60 s. Signing out doesn't close live sockets yet.
- **Storage is capped per notebook,** not per user.
