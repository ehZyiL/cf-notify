import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATION = join(__dirname, "..", "migrations", "0001_init.sql");

export function createSqliteD1(options = {}) {
  const filename = options.filename ?? ":memory:";
  const migrationSql =
    options.schemaSql ??
    (options.skipMigrate ? "" : readFileSync(options.migrationPath || DEFAULT_MIGRATION, "utf8"));

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
