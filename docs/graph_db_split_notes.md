# Graph DB Split Notes

## Summary

This note documents the current state of the bolt `graph.db` split work,
the intended Blixt usage, and the migration/versioning concerns that came
up during review.

Current behavior:

- `db.bolt.graphdbname` controls which bbolt file backs `GraphDB`.
- The default remains `channel.db` for compatibility.
- If set to `graph.db`, the graph store is opened from a separate bbolt
  file while channel state and Mission Control remain in `channel.db`.
- `speedloader.go` is intentionally out of scope. The mobile app is
  expected to download and replace `graph.db` itself while lnd is not
  running.

## Intended Blixt Model

The intended Blixt model is:

- `channel.db` contains local node state.
- `graph.db` is an app-managed, replaceable routing graph artifact.
- Primer sync is responsible for populating `graph.db`.
- Lack of migration from old local graph data in `channel.db` to
  `graph.db` is an intentional tradeoff.

This means the split is primarily a cache/artifact split, not a
durability-preserving migration feature.

## What Was Confirmed

### Empty `graph.db` does not appear to crash normal startup

Even if the configured graph backend is empty, normal startup does not
appear to fail due to a missing source node:

- `newServer` calls `setSelfNode(...)` first.
- `setSelfNode(...)` tolerates `graphdb.ErrSourceNodeNotSet`.
- It then persists a fresh source node into `GraphDB`.
- Only later does startup call `dbs.GraphDB.SourceNode(ctx)` again.

So the feared startup failure from an empty fresh `graph.db` was not
reproduced through the actual startup flow.

### `getinfo.synced_to_graph` is not a graph readiness signal

`synced_to_graph` reflects completion of initial historical gossip sync
with a peer in the current runtime. It does not mean:

- that `graph.db` exists,
- that graph data is present, or
- that a preloaded graph is usable.

For Blixt with server-seeded `graph.db`, this should not be used as a
hard payment gate.

## Current Risks And Constraints

### No migration when switching files

If an existing node changes `db.bolt.graphdbname` from `channel.db` to a
new file such as `graph.db`, existing graph data is not copied out of
`channel.db`.

For Blixt this is currently accepted because:

- the local graph cache is considered disposable, and
- Primer/Blixt sync is expected to replace/populate `graph.db`.

For a general upstream feature, this is a real limitation.

### Legacy graph migrations still belong to `channeldb`

The old KV schema versioning is still owned by `channeldb` metadata
(`metadata/dbp` and optional migration metadata). Some mandatory legacy
migrations are graph-specific:

- version 1: `MigrateNodeAndEdgeUpdateIndex`
- version 4: `MigrateEdgePolicies`
- version 6: `MigratePruneEdgeUpdateIndex`

Those currently run through `channeldb.CreateWithBackend(...)`, which
means they run against `ChanStateDB`, not independently against a split
`GraphDB`.

Implication:

- A fresh or modern Primer-supplied graph file is expected to be fine.
- An older graph file or snapshot may skip required legacy graph
  migrations when opened as `graph.db`.
- Future mandatory graph-related KV migrations would need attention if
  `GraphDB` remains split from `ChanStateDB`.

### Native SQL graph migration needed one fix

When `db.use-native-sql=true`, lnd can migrate the legacy KV graph store
into the native SQL graph store.

After introducing `db.bolt.graphdbname`, the graph KV data may live in
`GraphDB` instead of `ChanStateDB`. The SQL migration code was still
reading from `ChanStateDB`, which meant it could miss the actual graph
data when the graph was split into a separate file.

This was fixed by making the SQL graph migration read from
`databaseBackends.GraphDB`, which is the actual configured KV source for
graph data.

## Blixt Safety Assessment

With the current implementation, the split is considered safe enough for
Blixt if the following assumptions hold:

- `graph.db` is treated as replaceable cache/state, not durable user
  data.
- Primer serves files built from a compatible lnd version.
- Old Blixt versions are refused by the server if compatibility is not
  guaranteed.
- The app replaces `graph.db` only while lnd is not using it.
- If a supplied file is bad or incompatible, the fallback is to discard
  it and let gossip rebuild over time.

What is not guaranteed today:

- migration of old local graph data from `channel.db` into `graph.db`
- safe handling of arbitrary old graph files
- automatic handling of future graph-specific mandatory KV migrations

## Why This Gets Tricky

The split itself is simple. The complexity comes from the fact that the
historical migration system assumes graph and channel state share one DB
schema/version stream.

That creates tension between:

- Blixt's desired model, where `graph.db` is a replaceable artifact, and
- lnd's historical model, where graph and channel state were versioned
  together in one KV store.

## Practical Paths Forward

### Short-term Blixt path

Keep the current split and rely on strict compatibility policy:

- Primer and Blixt stay version-aligned.
- Older app versions may be refused by the server.
- Future lnd upgrades should be checked for any new mandatory
  graph-related KV migrations.

If a future graph-related KV migration appears, Blixt can patch lnd to
run that migration against `GraphDB`.

### Cleaner long-term path

Move graph migration ownership into `graphdb`:

- add graph-specific version metadata under `graph-meta`
- add a graph-owned migration runner
- bootstrap from legacy `metadata/dbp` only once if needed
- migrate graph data using `GraphDB`, regardless of whether the file is
  shared or split

This is the cleaner architectural solution, but it is more invasive.

## Native SQL Findings

### Current native SQL layout

For sqlite with `db.use-native-sql=true`, lnd currently creates a single
native SQL store at `lnd.sqlite`.

That single native SQL store is then shared by multiple subsystems:

- one migration stream is applied to the single store
- one `BaseDB` is created from that store
- invoice and graph SQL stores are then constructed on top of the same
  underlying `BaseDB`

This means graph is no longer in KV emulation in this mode, but it is
also not stored in a separate native SQL file.

### Why this matters for Blixt/mobile

For the current bbolt split model, Blixt can treat `graph.db` as a
replaceable graph artifact.

If the long-term storage direction is to move more data into a single
native SQL sqlite file, then the main mobile concern changes:

- the problem is no longer splitting KV graph and channel state
- the problem becomes whether graph can live in its own native SQL
  store/file instead of sharing `lnd.sqlite`

If graph shares one native SQL store with other local durable state,
then raw file replacement becomes much harder to use safely.

### Difficulty of splitting native SQL

Splitting native SQL graph storage into its own sqlite file looks
possible, but not trivial.

What would likely be needed:

- separate native SQL store handles instead of one `NativeSQLStore`
- separate migration application for each native SQL store
- separate `BaseDB` / transaction executors
- a decision on which tables remain in the main native SQL store and
  which move to a dedicated graph store

The good news is that the current SQL schema is already cleaner than the
old KV layout:

- invoice tables and graph tables are already in separate table families
- graph schema is introduced by `000008_graph`

So the main coupling is in the store/migration framework, not in the
data model itself.

### Practical conclusion

For Blixt, the main forward-looking sqlite question is:

- if native SQL is the long-term direction, can graph live in its own
  native SQL store/file instead of sharing the single `lnd.sqlite`
  store?

### Additional direction: pre-start graph import into sqlite

Another possible direction for sqlite/native SQL is to stop thinking in
terms of replacing a graph file entirely and instead import graph data
into the native SQL store before startup.

This could look like:

- Primer exports a graph artifact
- the app downloads it before starting lnd
- the app injects or copies graph tables into `lnd.sqlite`
- lnd then starts using the already-populated graph tables

Initial assessment:

- this is likely more aligned with the long-term native SQL direction
  than continuing to optimize around bbolt file replacement
- the import should be done pre-start and as a bulk operation
- the most promising implementation shape is likely table-level bulk
  copy in a single transaction, not row-by-row app insertion

Unknown:

- how fast a realistic full graph import into sqlite would be on mobile
  hardware

Expected performance intuition:

- replacing a dedicated graph file should still be the fastest option
- bulk import into sqlite may still be fast enough for startup seeding
- row-by-row insertion from app code is less attractive

Suggested benchmark direction:

1. Prepare a sqlite artifact containing graph tables only.
2. Before lnd startup, attach or open `lnd.sqlite`.
3. Clear/replace the existing graph tables in one bulk transaction.
4. Copy graph data into place and measure wall-clock time on device.

This benchmark is likely more useful than speculation, especially since
the graph SQL schema spans multiple related tables and indexes.

## Device Migration Angle

Splitting large replaceable graph/routing data away from small local node
state is useful not only for server-seeded graph sync, but also for
phone migration.

Motivation:

- with graph data out of the way, local channel-state data becomes small
  enough to be moved directly between phones
- this opens the door to device-to-device migration flows using tools
  such as Magic Wormhole or similar transport
- the old device can then be explicitly retired/"bricked" after the
  migration completes

Longer-term, if sqlite/native SQL becomes the stable direction, the best
end state may be:

- export/import only the compact local-state tables needed for device
  migration
- keep graph data re-seedable or independently syncable

That would avoid tying the feature too tightly to any one backend's raw
file layout.

## Primer Artifact Considerations

Primer currently does not need to split its own DB layout.

Two possible server artifact models were considered:

1. Continue serving a modern, compatible graph artifact and rely on
   version matching.
2. Eventually export a dedicated client artifact containing only the data
   Blixt should consume, rather than Primer's full local DB state.

Supplying Primer's full combined `channel.db` becomes problematic once
there is interest in shipping Mission Control-like data, because that
would also include Primer's own local channel state and other non-graph
data.

## Open Questions For Upstreaming

If this work is proposed upstream, the main open question is:

- are there plans to split graph and channel-state schema
  versioning/migrations so `graphdb` can own its own version/meta and
  migration path independently of `channeldb`?

Relevant files:

- `channeldb/db.go`
- `channeldb/meta.go`
- `channeldb/migration_01_to_11/migrations.go`
- `graph/db/kv_store.go`
- `graph/db/sql_migration.go`
- `config_builder.go`
- `lncfg/db.go`
