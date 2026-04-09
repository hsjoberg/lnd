import { Database } from "bun:sqlite";

type StepResult = {
  label: string;
  ms: number;
};

type Options = {
  db: string;
  artifact: string;
  validateOnly: boolean;
  keepTransactionOpen: boolean;
  tempStoreMemory: boolean;
};

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun scripts/sqlite-attach-import-benchmark.ts --db <lnd.sqlite> --artifact <lnd_server.sqlite> [--validate-only] [--keep-transaction-open] [--temp-store-memory]",
      "",
      "Examples:",
      "  bun scripts/sqlite-attach-import-benchmark.ts --db ./lnddir/data/graph/mainnet/lnd.sqlite --artifact ./lnddir/data/graph/mainnet/lnd_server.sqlite",
      "  bun scripts/sqlite-attach-import-benchmark.ts --db ./lnddir/data/graph/signet/lnd.sqlite --artifact ./lnddir/data/graph/signet/lnd_server.sqlite --validate-only",
      "  bun scripts/sqlite-attach-import-benchmark.ts --db ./lnddir/data/graph/mainnet/lnd.sqlite --artifact ./lnddir/data/graph/mainnet/lnd_server.sqlite --temp-store-memory",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  let db = "";
  let artifact = "";
  let validateOnly = false;
  let keepTransactionOpen = false;
  let tempStoreMemory = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--db":
        db = argv[++i] ?? "";
        break;

      case "--artifact":
        artifact = argv[++i] ?? "";
        break;

      case "--validate-only":
        validateOnly = true;
        break;

      case "--keep-transaction-open":
        keepTransactionOpen = true;
        break;

      case "--temp-store-memory":
        tempStoreMemory = true;
        break;

      case "--help":
      case "-h":
        usage();
        break;

      default:
        console.error(`Unknown argument: ${arg}`);
        usage();
    }
  }

  if (!db || !artifact) {
    usage();
  }

  return {
    db,
    artifact,
    validateOnly,
    keepTransactionOpen,
    tempStoreMemory,
  };
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nowMs(): number {
  return performance.now();
}

function timed(label: string, fn: () => void): StepResult {
  const started = nowMs();
  fn();
  return {
    label,
    ms: nowMs() - started,
  };
}

function countRow(db: Database, sql: string): number {
  const row = db.query(sql).get() as Record<string, number> | null;
  if (!row) {
    throw new Error(`No row returned for count query: ${sql}`);
  }

  const first = Object.values(row)[0];
  return Number(first);
}

function printCounts(db: Database): void {
  const countQueries = [
    {
      label: "artifact.graph_nodes",
      sql: "SELECT count(*) AS n FROM artifact.graph_nodes",
    },
    {
      label: "artifact.graph_channels",
      sql: "SELECT count(*) AS n FROM artifact.graph_channels",
    },
    {
      label: "artifact.graph_channel_policies",
      sql: "SELECT count(*) AS n FROM artifact.graph_channel_policies",
    },
    {
      label: "main.graph_nodes",
      sql: "SELECT count(*) AS n FROM main.graph_nodes",
    },
    {
      label: "main.graph_channels",
      sql: "SELECT count(*) AS n FROM main.graph_channels",
    },
    {
      label: "main.graph_channel_policies",
      sql: "SELECT count(*) AS n FROM main.graph_channel_policies",
    },
  ];

  console.log("\nCounts:");
  for (const query of countQueries) {
    const started = nowMs();
    const value = countRow(db, query.sql);
    const elapsed = nowMs() - started;
    console.log(
      `  ${query.label}: ${value.toLocaleString()} (${elapsed.toFixed(3)} ms)`,
    );
  }
}

function run(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = new Database(opts.db, { strict: true });

  const steps: StepResult[] = [];
  const deleteStatements = [
    "DELETE FROM main.graph_channel_policy_extra_types",
    "DELETE FROM main.graph_channel_policies",
    "DELETE FROM main.graph_channel_extra_types",
    "DELETE FROM main.graph_channel_features",
    "DELETE FROM main.graph_zombie_channels",
    "DELETE FROM main.graph_prune_log",
    "DELETE FROM main.graph_closed_scids",
    "DELETE FROM main.graph_channels",
    "DELETE FROM main.graph_node_addresses",
    "DELETE FROM main.graph_node_features",
    "DELETE FROM main.graph_node_extra_types",
    "DELETE FROM main.graph_source_nodes",
    "DELETE FROM main.graph_nodes",
  ];
  const insertStatements = [
    "INSERT INTO main.graph_nodes SELECT * FROM artifact.graph_nodes",
    "INSERT INTO main.graph_node_extra_types SELECT * FROM artifact.graph_node_extra_types",
    "INSERT INTO main.graph_node_features SELECT * FROM artifact.graph_node_features",
    "INSERT INTO main.graph_node_addresses SELECT * FROM artifact.graph_node_addresses",
    "INSERT INTO main.graph_source_nodes SELECT * FROM artifact.graph_source_nodes",
    "INSERT INTO main.graph_channels SELECT * FROM artifact.graph_channels",
    "INSERT INTO main.graph_channel_features SELECT * FROM artifact.graph_channel_features",
    "INSERT INTO main.graph_channel_extra_types SELECT * FROM artifact.graph_channel_extra_types",
    "INSERT INTO main.graph_channel_policies SELECT * FROM artifact.graph_channel_policies",
    "INSERT INTO main.graph_channel_policy_extra_types SELECT * FROM artifact.graph_channel_policy_extra_types",
    "INSERT INTO main.graph_zombie_channels SELECT * FROM artifact.graph_zombie_channels",
    "INSERT INTO main.graph_prune_log SELECT * FROM artifact.graph_prune_log",
    "INSERT INTO main.graph_closed_scids SELECT * FROM artifact.graph_closed_scids",
  ];

  try {
    steps.push(
      timed("PRAGMA foreign_keys = ON", () => {
        db.exec("PRAGMA foreign_keys = ON");
      }),
    );
    steps.push(
      timed("PRAGMA busy_timeout = 5000", () => {
        db.exec("PRAGMA busy_timeout = 5000");
      }),
    );
    if (opts.tempStoreMemory) {
      steps.push(
        timed("PRAGMA temp_store = MEMORY", () => {
          db.exec("PRAGMA temp_store = MEMORY");
        }),
      );
    }
    steps.push(
      timed("BEGIN IMMEDIATE", () => {
        db.exec("BEGIN IMMEDIATE");
      }),
    );
    steps.push(
      timed("ATTACH artifact", () => {
        db.exec(
          `ATTACH DATABASE ${quoteSqlString(opts.artifact)} AS artifact`,
        );
      }),
    );

    printCounts(db);

    if (!opts.validateOnly) {
      for (const statement of deleteStatements) {
        steps.push(
          timed(statement, () => {
            db.exec(statement);
          }),
        );
      }

      for (const statement of insertStatements) {
        steps.push(
          timed(statement, () => {
            db.exec(statement);
          }),
        );
      }
    }

    if (!opts.keepTransactionOpen) {
      steps.push(
        timed("COMMIT", () => {
          db.exec("COMMIT");
        }),
      );
      steps.push(
        timed("DETACH artifact", () => {
          db.exec("DETACH DATABASE artifact");
        }),
      );
    }
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors if no transaction is active anymore.
    }
    throw error;
  } finally {
    db.close();
  }

  const deleteMs = steps
    .filter((step) => step.label.startsWith("DELETE FROM "))
    .reduce((sum, step) => sum + step.ms, 0);
  const insertMs = steps
    .filter((step) => step.label.startsWith("INSERT INTO "))
    .reduce((sum, step) => sum + step.ms, 0);
  const otherMs = steps
    .filter(
      (step) =>
        !step.label.startsWith("DELETE FROM ") &&
        !step.label.startsWith("INSERT INTO "),
    )
    .reduce((sum, step) => sum + step.ms, 0);
  const totalMs = steps.reduce((sum, step) => sum + step.ms, 0);

  console.log("\nSteps:");
  for (const step of steps) {
    console.log(`  ${step.label}: ${step.ms.toFixed(3)} ms`);
  }

  console.log("\nTotals:");
  console.log(`  delete: ${deleteMs.toFixed(3)} ms`);
  console.log(`  insert: ${insertMs.toFixed(3)} ms`);
  console.log(`  other:  ${otherMs.toFixed(3)} ms`);
  console.log(`  total:  ${totalMs.toFixed(3)} ms`);
}

run();
