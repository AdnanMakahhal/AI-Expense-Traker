import test from "node:test";
import assert from "node:assert/strict";
import pool from "../db.js";
import { getTransactions, createTransaction, updateTransaction } from "../controllers/transactionController.js";

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("transaction filters reject oversized batches and invalid calendar dates", async () => {
  for (const query of [{ limit: "2000" }, { startDate: "2026-02-30" }, { offset: "-1" }]) {
    const res = response();
    await getTransactions({ query, userId: 1 }, res);
    assert.equal(res.statusCode, 400);
  }
});

test("paginated queries retain user ownership and parameterized filters", async (t) => {
  const queries = [];
  t.mock.method(pool, "query", async (sql, values) => {
    queries.push({ sql, values });
    return { rows: [] };
  });
  const res = response();
  await getTransactions({ userId: 42, query: { limit: "100", offset: "100", search: "coffee" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(queries[0].sql, /t.user_id = \$1/);
  assert.deepEqual(queries[0].values, [42, "%coffee%", 100, 100]);
});

test("invalid category updates are rejected rather than clearing the category", async () => {
  for (const categoryId of ["abc", -1, 1.5, {}, "9007199254740992"]) {
    const res = response();
    await updateTransaction({ params: { id: "1" }, body: { categoryId }, userId: 1 }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, "Invalid categoryId");
  }
});

test("expenses cannot use another user's category or an income category", async (t) => {
  t.mock.method(pool, "query", async (sql, values) => {
    assert.match(sql, /user_id = \$2 AND type = \$3/);
    assert.deepEqual(values, [3, 42, "expense"]);
    return { rows: [] };
  });
  const res = response();
  await createTransaction({ userId: 42, body: { categoryId: 3, amount: "12.50", type: "expense", transactionDate: "2026-11-01" } }, res);
  assert.equal(res.statusCode, 400);
});

test.after(async () => { await pool.end(); });
