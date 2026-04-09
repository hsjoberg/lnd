# SQLite Graph Import Notes

## Summary

This note collects the sqlite/native-SQL graph import ideas separately
from the bbolt split notes.

Current direction:

- keep the bbolt split for Blixt for now
- investigate sqlite/native SQL as the long-term direction
- prefer import/seeding ideas that work after lnd has already migrated
  its local schema

## Why Pre-start Import Looks Risky

Pre-start raw import into sqlite looks hazardous because Blixt may
download a graph artifact before lnd has had a chance to migrate the
local sqlite schema.

That creates the risk that:

1. Blixt updates.
2. The app syncs a graph artifact built for the latest server/lnd
   version.
3. Local lnd has not yet migrated its own sqlite store.
4. The imported graph data is ahead of the local schema/state.

Because of that, the safer sequencing looks like:

1. Start lnd normally.
2. Let native SQL migrations complete first.
3. Import graph data into the already-current schema.

## Runtime Import Already Has Precedent

There is already a dev-only graph import RPC:

- `lnrpc/devrpc/dev_server.go`

Important detail:

- it imports through the live `*graphdb.ChannelGraph`
- it does not write around lnd behind its back

That matters because `ChannelGraph` runtime writes already:

- write to the backing store
- update the in-memory graph cache
- emit topology notifications

So live graph mutation is already part of lnd's normal runtime model.
The current dev RPC is not optimized for production use, but it shows
that post-start import is structurally viable.

Mission Control import is a weaker precedent:

- `routerrpc.XImportMissionControl`
- imports state only in memory
- not persisted across restarts

The graph import path is the stronger precedent for a future
"Speedloader 2.0" design.

## Candidate Import Formats

Two main artifact shapes were considered:

1. schema-independent interchange format, such as protobuf
2. sqlite graph artifact imported directly with SQL

### Protobuf-like artifact

Pros:

- less tightly coupled to lnd's exact SQL schema
- easier to version as an interchange contract
- safer if internal table layout changes

Cons:

- requires decode + conversion into internal models
- likely slower than direct SQL bulk import

### SQLite graph artifact

Pros:

- likely the fastest sqlite-native import approach
- avoids protobuf decode/model conversion cost
- allows bulk SQL copy with `ATTACH`

Cons:

- tightly coupled to lnd's exact SQL schema
- only safe when artifact and running lnd expect the same schema

## `ATTACH` Fast Path

The likely fastest sqlite-native import path is:

1. lnd is already running and migrated
2. app passes lnd a path to a sqlite graph artifact
3. lnd attaches that sqlite DB
4. lnd bulk-copies graph tables into the real store in one transaction

This is effectively:

- `ATTACH`
- `INSERT INTO ... SELECT ...`
- one import transaction

This is probably the best fast path if exact-version matching is
acceptable.

## Why Exact Version Gating Matters

The sqlite/native SQL migration stream is currently shared.

Relevant facts:

- migrations are defined in `sqldb/migrations.go`
- graph schema is introduced by `000008_graph`
- the same migration config also includes custom migrations such as
  `kv_graph_migration`

So it is not enough to say "migrations probably happen rarely".
The importer should compare against the exact migration/schema version
expected by the running lnd.

Safe model:

1. start lnd and let native SQL migrations complete
2. read the artifact metadata
3. compare the artifact version to the version expected by the running
   lnd
4. import only on exact match
5. otherwise reject the artifact and fetch/build a compatible one

This is stricter than strictly necessary in some cases, but it is the
safest v1 rule.

## API Shape For Blixt

For Blixt specifically, a public upstream gRPC method may not be the
best first shape.

A cleaner Blixt-only interface could be a mobile/cgo-facing local
function such as:

- `ImportChannelGraphFromFile(path string) error`

That would:

- take a local artifact path
- validate compatibility
- perform the import internally

This avoids adding a public "read arbitrary path" RPC while still
providing a practical app-facing import mechanism.

## Production-grade Importer Expectations

The current dev `ImportGraph` RPC is useful as proof that runtime import
is possible, but it is probably not the final implementation shape for a
large graph artifact.

A faster production path should likely:

- avoid per-record RPC overhead
- avoid per-record topology notifications if possible
- import in coarse batches or one transaction
- rebuild or refresh graph cache once at the end if needed

For sqlite specifically, that points toward:

- a local/mobile entrypoint
- exact-version-gated sqlite artifact
- `ATTACH`-based bulk import

## Current Design Candidates

At this point the leading candidates look like:

1. Continue with the bbolt split for Blixt now.
2. Raise upstream concerns/questions about the long-term native SQL
   direction.
3. For future sqlite/native SQL graph sync, prefer post-start import
   over pre-start raw file replacement.
4. If exact-version matching is acceptable, use a sqlite graph artifact
   plus `ATTACH` as the fast path.
5. If looser compatibility is ever needed, use a more stable interchange
   format such as protobuf and convert into the current schema inside
   lnd.
