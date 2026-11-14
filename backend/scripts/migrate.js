import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const DROP_ALL = `
    DROP TABLE IF EXISTS ai_insights CASCADE;
    DROP TABLE IF EXISTS budgets CASCADE;
    DROP TABLE IF EXISTS transactions CASCADE;
    DROP TABLE IF EXISTS categories CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
`;

const runMigration = async () => {
  const shouldReset = process.argv.includes("--reset");
  const schemaPath = path.join(dirname, "..", "sql", "schema.sql");

  try {
    const schema = await fs.readFile(schemaPath, "utf8");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      if (shouldReset) {
        console.log("Dropping existing tables...");
        await client.query(DROP_ALL);
      }

      console.log(`Running migration from ${schemaPath}...`);
      await client.query(schema);
      await client.query("COMMIT");
      console.log("Migration complete. Tables created.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

runMigration();
