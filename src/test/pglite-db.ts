/**
 * Test helper: a real in-memory PGlite database with the drizzle migrations
 * applied, injectable in place of `@/server/db` via `vi.mock`.
 *
 * Usage in a test file:
 *
 *   vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());
 *   const ctx = setupTestDb();               // registers beforeAll/beforeEach/afterAll
 *   const { userId, categoryId } = await seedBasics();
 */
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach } from "vitest";
import * as schema from "@/server/db/schema";

type TestDatabase = PgliteDatabase<typeof schema>;

let current: { client: PGlite; db: TestDatabase } | null = null;

function requireCurrent() {
  if (current === null) throw new Error("Test DB not initialised; call setupTestDb()");
  return current;
}

/** Stand-in for `db` from `@/server/db`; delegates to the active test database. */
export const testDb = new Proxy({} as TestDatabase, {
  get(_t, prop) {
    const { db } = requireCurrent();
    const value = Reflect.get(db, prop, db);
    return typeof value === "function" ? value.bind(db) : value;
  },
});

/** Module shape returned from the `vi.mock("@/server/db")` factory. */
export function dbModuleMock() {
  return {
    db: testDb,
    client: new Proxy({} as PGlite, {
      get(_t, prop) {
        const { client } = requireCurrent();
        const value = Reflect.get(client, prop, client);
        return typeof value === "function" ? value.bind(client) : value;
      },
    }),
    schema,
    isUsingPostgres: () => false,
    getPglitePath: () => "memory://",
  };
}

export async function createMigratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  return { client, db };
}

const TABLES = [
  "agent_actions",
  "api_tokens",
  "calendar_events",
  "calendar_configs",
  "sync_logs",
  "spreadsheet_configs",
  "break_entries",
  "time_entries",
  "daily_attendance",
  "tasks",
  "categories",
  "users",
];

/** Registers lifecycle hooks: one migrated PGlite per file, emptied before each test. */
export function setupTestDb() {
  beforeAll(async () => {
    current = await createMigratedDb();
  }, 60_000);
  beforeEach(async () => {
    const { db } = requireCurrent();
    await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
  });
  afterAll(async () => {
    if (current !== null) {
      await current.client.close();
      current = null;
    }
  });
  return { db: testDb };
}

let counter = 0;

/** Inserts a user and a category; returns their ids. */
export async function seedBasics(opts: { timezone?: string } = {}) {
  counter += 1;
  const [user] = await testDb
    .insert(schema.users)
    .values({
      name: `User ${counter}`,
      email: `user${counter}-${Date.now()}@example.com`,
      timezone: opts.timezone ?? "Asia/Jakarta",
    })
    .returning();
  const [category] = await testDb
    .insert(schema.categories)
    .values({ key: `cat-${counter}-${Date.now()}`, name: "Development" })
    .returning();
  return { userId: user.id, categoryId: category.id };
}
