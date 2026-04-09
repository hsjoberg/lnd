# Draft GitHub Issue: Native SQL Graph Store Separation

## Title

Native SQL sqlite: consider separate graph store/file

## Draft Body

I am looking at splitting graph storage from channel-state storage so
that graph data can live in its own store/file instead of always sharing
the main database.

With the current bbolt-backed layout, this can be approached by
separating `ChanStateDB` and `GraphDB` into separate files such as
`channel.db` and `graph.db`, then letting the app replace `graph.db`
while lnd is not running.

However, the long-term direction seems to be moving away from KV
emulation and toward native SQL / schema-based tables. In the current
sqlite native-SQL path, there is a single native SQL store
(`lnd.sqlite`), and graph SQL tables appear to live in that shared store
rather than in a dedicated graph store/file.

The reason I am raising this is concern about future graph syncing for
mobile/light clients such as Blixt. If graph remains part of a single
shared native SQL store, replacing or syncing graph data independently
becomes much harder.

More generally, this raises a forward-looking architectural concern:

- if more data consolidates into a single native SQL store, replacing a
  file to sync graph data becomes much harder unless graph can live in a
  dedicated native SQL store/file, or there is an official graph
  import/export/sync mechanism

The current SQL schema already seems cleaner than the old KV layout
because graph tables are grouped under the graph SQL migration and do not
appear tightly coupled to invoice tables at the schema level. The main
coupling seems to be in the store/migration framework, where one native
SQL store and one migration stream are used.

Questions:

1. Are there any plans to let graph live in its own native SQL store/file
   under sqlite, instead of sharing the single `lnd.sqlite` store?
2. If not, is there another intended approach for mobile clients that
   want to sync/seed graph data from a server without sharing the rest of
   the local node state?
3. If native SQL remains consolidated, would an application-level graph
   import/export path be the preferred direction instead of file-level
   replacement?

Relevant code paths I was looking at:

- `lncfg/db.go`
- `config_builder.go`
- `sqldb/migrations.go`
- `sqldb/sqlc/migrations/000008_graph.up.sql`
- `graph/db/sql_store.go`
