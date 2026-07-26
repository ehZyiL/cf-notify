import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function readMigrations(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

export function createSqliteD1(options = {}) {
  const filename = options.filename ?? ":memory:";
  const migrationSql =
    options.schemaSql ??
    (options.skipMigrate
      ? ""
      : options.migrationPath
        ? readFileSync(options.migrationPath, "utf8")
        : readMigrations(options.migrationsDir || DEFAULT_MIGRATIONS_DIR));

  const database = new DatabaseSync(filename);
  if (migrationSql) database.exec(migrationSql);

  function bound(sql, params) {
    return {
      async first() {
        const stmt = database.prepare(sql);
        const row = params.length ? stmt.get(...params) : stmt.get();
        return row === undefined ? null : row;
      },
      async all() {
        const stmt = database.prepare(sql);
        const results = params.length ? stmt.all(...params) : stmt.all();
        return { results: results || [], success: true };
      },
      async run() {
        const stmt = database.prepare(sql);
        const info = params.length ? stmt.run(...params) : stmt.run();
        return { success: true, meta: info || {} };
      },
      bind(...next) {
        return bound(sql, next);
      }
    };
  }

  return {
    prepare(sql) {
      return bound(sql, []);
    },
    _close() {
      database.close();
    }
  };
}

export function createMemoryDb() {
  return createSqliteD1();
}
