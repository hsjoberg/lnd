# SQLite `ATTACH` Import Plan

## Summary

This note documents the current leading plan for Blixt graph sync once
sqlite/native SQL becomes the target path.

The current idea is:

- do not import before lnd has migrated its local sqlite schema
- do not import after the graph subsystem has started
- instead import while lnd is in wallet state `LOCKED`
- use sqlite `ATTACH` to bulk-copy a graph artifact into `lnd.sqlite`

This is currently the cleanest combination of:

- speed
- schema safety
- simple mobile integration

## Why `LOCKED` Is The Right Window

Startup order matters.

What is true during `LOCKED`:

- databases are already opened
- native SQL migrations should already have run
- `graphDB.Start()` has not run yet
- graph builder, router, and gossiper are not started yet
- the in-memory graph cache has not been populated yet

This is ideal for import because:

- local schema is already current
- no live graph users are active yet
- startup will later populate the graph cache from the imported DB state

So the intended flow is:

1. Start embedded lnd.
2. Wait until wallet state is `LOCKED`.
3. Run graph import into `lnd.sqlite`.
4. Close the app-side sqlite connection.
5. Unlock wallet.
6. Let normal startup continue.

## Why This Is Better Than Post-start Runtime Import

There is already precedent for runtime graph mutation in lnd:

- `lnrpc/devrpc/dev_server.go` has `ImportGraph`
- `ChannelGraph` writes already update DB, cache, and topology state

But that path is not ideal for this use case.

If import happens after graph startup:

- graph cache is already live
- topology notification channels are active
- router/gossiper may already be reading graph state

That makes import more complex.

By importing in `LOCKED`:

- there is no need to rebuild or swap the in-memory graph cache manually
- later `graphDB.Start()` will populate the cache from DB contents
- no topology notifications are needed

### Important caveat: some SQL graph caches already exist

Even in `LOCKED`, the SQL graph store instance has already been created.
That means some smaller in-memory SQL-side caches also already exist:

- reject cache
- channel cache

The current plan assumes this is still acceptable because:

- the graph subsystem has not started yet
- these caches should still be cold if no graph reads happen before
  unlock/import completes

So the current v1 safety assumption is:

- no relevant graph reads happen before import completes

If that assumption turns out to be false in practice, then a future
cache invalidation/reset hook may be needed.

## Why App-side sqlite Is Attractive

One pain point with speedloader has been needing to bundle it together
with the mobile bindings because there cannot be two separate libraries
running the Go runtime at the same time.

App-side sqlite avoids that.

Current idea:

- Blixt itself opens `lnd.sqlite` using `react-native-turbo-sqlite`
- runs the import in `LOCKED`
- closes the DB
- then unlocks the wallet

This avoids:

- a second bundled Go speedloader path
- needing a new lnd import RPC for the first iteration

## Why `ATTACH` Looks Best

`ATTACH` lets one sqlite connection temporarily open another sqlite
database and copy between them in SQL.

Example shape:

```sql
ATTACH DATABASE '/path/to/graph-artifact.sqlite' AS artifact;
INSERT INTO main.graph_nodes (...)
SELECT ...
FROM artifact.graph_nodes;
DETACH DATABASE artifact;
```

This is attractive because:

- one sqlite connection
- one transaction
- direct table-to-table copy
- no protobuf decode cost
- no model conversion cost
- likely much faster than row-by-row insertion

For this use case, the artifact would likely be a sqlite database
containing graph tables only.

## Version Gating

`ATTACH` is only safe if the artifact schema matches what the running lnd
expects.

So import should be exact-version-gated.

The intended safety rule is:

1. start lnd
2. let native SQL migrations complete
3. app reads artifact metadata
4. compare artifact schema/migration version to the running lnd's
   expected version
5. import only on exact match
6. otherwise reject the artifact

The sqlite/native SQL migration stream is currently shared and defined in:

- `sqldb/migrations.go`

So this should be treated as exact compatibility, not best-effort.

## Artifact Contents

The current assumption is:

- Blixt does not use publicly announced local channels
- therefore preserving local public channel graph rows is likely
  unnecessary

The main remaining local graph detail is the source node.

That may not need explicit preservation either, because lnd can recreate
the source node during normal startup if needed.

So the current simplest model is:

- import remote/public graph data
- do not worry about preserving local public graph rows

This should still be verified carefully once the first importer exists.

## TurboSqlite API Shape

The current `react-native-turbo-sqlite` API already exposes:

- `openDatabase(path)`
- `executeSql(sql, params)`

Because `executeSql` runs on the same underlying `sqlite3*` connection,
`ATTACH` should work as just another SQL statement on that connection.

So:

- one opened handle to `lnd.sqlite`
- `ATTACH` the artifact DB inside that handle
- run all delete/insert statements on the same handle

There is no need for the library to "open two DBs" at the JS API level.

### Important caveat: connection-local PRAGMAs still matter

`react-native-turbo-sqlite` currently opens sqlite with a plain
`sqlite3_open(...)` path, while lnd's sqlite store applies several sqlite
settings when it opens `lnd.sqlite`.

For correctness, the app-side import connection should explicitly set:

- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000` (or similar)

And the import transaction should use:

- `BEGIN IMMEDIATE`

Without these, the import connection may:

- skip foreign-key enforcement during the bulk copy
- fail too eagerly with `SQLITE_BUSY` against lnd's already-open handle

For Blixt specifically, matching lnd's sqlite expectations as closely as
practical is preferable.

Additional sqlite settings used by lnd, such as:

- `journal_mode=WAL`
- `synchronous=FULL`
- `fullfsync=true`
- `auto_vacuum=incremental`

are still worth understanding, but they are not all equally important for
the first import path.

For v1, the practical distinction is:

- **Must match for import correctness/locking:** `foreign_keys`,
  `busy_timeout`, and `BEGIN IMMEDIATE`
- **Nice to match / broader DB policy:** WAL and the durability-related
  PRAGMAs

So the app-side importer does not need to fully replicate every lnd
sqlite open option on day one, but it should match the connection-local
settings that affect transactional correctness and lock behavior.

### Planned transaction helper

To make this practical, a transaction helper in TurboSqlite makes sense:

- `withTransactionAsync(async (db) => { ... })`

Recommended shape:

- callback gets a transaction-bound DB handle
- all statements use the same connection
- `BEGIN IMMEDIATE`
- auto `ROLLBACK` on throw/reject
- auto `COMMIT` on success

Even better if transaction mode can be explicit:

- `withTransactionAsync({ mode: "immediate" }, async (tx) => { ... })`

For graph import, `IMMEDIATE` is preferred because we want the write lock
up front.

### Batch helper

A batch helper would also be useful because import will likely execute a
large series of statements:

- `ATTACH`
- multiple `DELETE`
- multiple `INSERT INTO ... SELECT ...`
- `DETACH`

Possible shape:

- `executeBatchAsync([[sql, params], ...])`

This would reduce JS/native bridge overhead.

For the actual graph import path, this is probably the best follow-up
optimization after the basic flow is working, because:

- the import currently issues many statements in sequence
- Bun/sqlite CLI timings already show SQL execution is fast enough
- the remaining app-side overhead will mostly be bridge/callback churn

So the likely TurboSqlite priority order is:

1. `withTransactionAsync({ mode: "immediate" }, ...)`
2. `executeBatchAsync(...)`
3. optional performance tuning such as `temp_store=MEMORY`

## Why This Should Eventually Be Used By lnd

Concern:

- if app-side sqlite mutates the DB directly, will lnd actually use the
  imported graph later?

In this `LOCKED` design, yes.

Why:

- the graph cache is populated later during `graphDB.Start()`
- that population reads from the DB
- so if import happens before startup continues, the imported graph
  becomes the source of truth for cache population

This is much safer than importing after graph startup, where direct SQL
mutation would bypass already-live caches.

## Managed vs Unmanaged Import

Two possible models were discussed:

1. Managed import inside lnd
2. App-side sqlite import

For Blixt, app-side sqlite import currently looks acceptable because it
happens in `LOCKED`, before graph startup.

So "managed import" is not required for the first version if all of the
following hold:

- import only in `LOCKED`
- exact version gating
- one exclusive transaction
- no wallet unlock until import is done

If import ever needs to happen after graph startup, then a more managed
lnd-owned importer would likely become necessary.

## Leading Implementation Plan

1. Keep bbolt split for Blixt for now.
2. Continue investigating sqlite/native SQL as the long-term path.
3. Add `withTransactionAsync` to `react-native-turbo-sqlite`.
4. Potentially also add `executeBatchAsync`.
5. Wait for lnd wallet state `LOCKED`.
6. Open `lnd.sqlite` from the app.
7. Set required connection PRAGMAs on the app-side sqlite handle.
8. Validate graph artifact metadata/version.
9. Run an `ATTACH`-based bulk import transaction.
10. Close sqlite handle.
11. Unlock wallet and let normal startup populate graph cache.

## Proof Of Concept Result

This plan is no longer just theoretical.

A manual `sqlite3` proof of concept worked against a live `lnd.sqlite`
while lnd was in wallet state `LOCKED`:

- lnd had already opened and migrated `lnd.sqlite`
- sqlite CLI could still open the same DB
- `BEGIN IMMEDIATE` succeeded
- `ATTACH` of a copied server artifact DB succeeded
- graph tables could be deleted and repopulated from the artifact
- `COMMIT` succeeded
- `DETACH` succeeded after the transaction ended

That demonstrates the core idea:

- app-side sqlite import in `LOCKED` is viable
- sqlite locking does not immediately prevent this flow
- the graph tables are indeed readable/writable in `lnd.sqlite`

### Important transaction ordering

One detail was proven during the manual test:

- `DETACH` before ending the transaction fails with:
  - `database artifact is locked`

So the correct ordering is:

1. `BEGIN IMMEDIATE`
2. `ATTACH DATABASE ... AS artifact`
3. perform copy/delete/insert work
4. `COMMIT`
5. `DETACH DATABASE artifact`

In other words:

- do **not** `DETACH` before `COMMIT`

## Manual `sqlite3` Recipe

Example interactive flow:

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
BEGIN IMMEDIATE;
ATTACH DATABASE './lnddir/data/graph/signet/lnd_server.sqlite' AS artifact;
```

Sanity-check both DBs:

```sql
SELECT count(*) FROM artifact.graph_nodes;
SELECT count(*) FROM artifact.graph_channels;
SELECT count(*) FROM artifact.graph_channel_policies;

SELECT count(*) FROM main.graph_nodes;
SELECT count(*) FROM main.graph_channels;
SELECT count(*) FROM main.graph_channel_policies;
```

In the proof-of-concept run, both sides matched:

- `graph_nodes = 132`
- `graph_channels = 651`
- `graph_channel_policies = 1269`

## Current Delete/Insert Order

The following order worked in a manual proof-of-concept transaction.

### Delete order

```sql
DELETE FROM main.graph_channel_policy_extra_types;
DELETE FROM main.graph_channel_policies;
DELETE FROM main.graph_channel_extra_types;
DELETE FROM main.graph_channel_features;
DELETE FROM main.graph_zombie_channels;
DELETE FROM main.graph_prune_log;
DELETE FROM main.graph_closed_scids;
DELETE FROM main.graph_channels;
DELETE FROM main.graph_node_addresses;
DELETE FROM main.graph_node_features;
DELETE FROM main.graph_node_extra_types;
DELETE FROM main.graph_source_nodes;
DELETE FROM main.graph_nodes;
```

### Insert order

```sql
INSERT INTO main.graph_nodes
SELECT * FROM artifact.graph_nodes;

INSERT INTO main.graph_node_extra_types
SELECT * FROM artifact.graph_node_extra_types;

INSERT INTO main.graph_node_features
SELECT * FROM artifact.graph_node_features;

INSERT INTO main.graph_node_addresses
SELECT * FROM artifact.graph_node_addresses;

INSERT INTO main.graph_source_nodes
SELECT * FROM artifact.graph_source_nodes;

INSERT INTO main.graph_channels
SELECT * FROM artifact.graph_channels;

INSERT INTO main.graph_channel_features
SELECT * FROM artifact.graph_channel_features;

INSERT INTO main.graph_channel_extra_types
SELECT * FROM artifact.graph_channel_extra_types;

INSERT INTO main.graph_channel_policies
SELECT * FROM artifact.graph_channel_policies;

INSERT INTO main.graph_channel_policy_extra_types
SELECT * FROM artifact.graph_channel_policy_extra_types;

INSERT INTO main.graph_zombie_channels
SELECT * FROM artifact.graph_zombie_channels;

INSERT INTO main.graph_prune_log
SELECT * FROM artifact.graph_prune_log;

INSERT INTO main.graph_closed_scids
SELECT * FROM artifact.graph_closed_scids;
```

### End of transaction

```sql
COMMIT;
DETACH DATABASE artifact;
```

This is the current best-known working order.

It should still be treated as:

- validated enough for prototype work
- but worth checking against the schema/FK definitions before hardening
  into production code

## Open Questions

- exact artifact metadata format
- whether any source-node preservation is desirable
- whether this delete/insert order should be refined after checking every
  graph table FK relationship more carefully
- whether any sqlite pragmas should be tuned for import speed
- whether the app should reject import if the DB is not in `LOCKED`
- whether a future explicit SQL graph cache reset hook should exist

## Import Speed Follow-ups

Current mainnet proof-of-concept timing is already strong, at roughly
`1.3s` total for a full graph replace via `ATTACH`.

That means speed work should stay conservative at first.

The current recommended optimization order is:

1. keep the import in one transaction
2. add a native-side batch execution API to reduce JS/native bridge churn
3. benchmark `PRAGMA temp_store = MEMORY`
4. only later consider artifact curation (for example excluding zombie
   state) if size or import time still matters

`PRAGMA temp_store = MEMORY` is the first low-risk sqlite tuning worth
testing because it does not require changing the high-level import model.

It should be treated as an experiment, not a required part of v1.

The benchmark script supports this now via:

```bash
bun scripts/sqlite-attach-import-benchmark.ts \
  --db ./lnddir/data/graph/mainnet/lnd.sqlite \
  --artifact ./lnddir/data/graph/mainnet/lnd_server.sqlite \
  --temp-store-memory
```
