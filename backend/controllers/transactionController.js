import pool from "../db.js";
import { analyzeTransactionList } from "../utils/gemini.js";

const isValidDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const parseInteger = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const getTransactions = async (req, res) => {
  const {
    startDate,
    endDate,
    categoryId,
    type,
    search,
    limit: rawLimit,
    offset: rawOffset,
  } = req.query;

  const limit = parseInteger(rawLimit, 50);
  const offset = parseInteger(rawOffset, 0);
  const parsedCategoryId =
    categoryId === undefined ? undefined : parseInteger(categoryId, null);

  if (
    (startDate !== undefined && !isValidDate(startDate)) ||
    (endDate !== undefined && !isValidDate(endDate)) ||
    (startDate && endDate && startDate > endDate) ||
    (parsedCategoryId !== undefined &&
      (parsedCategoryId === null || parsedCategoryId < 1)) ||
    (type !== undefined && !["income", "expense"].includes(type)) ||
    (search !== undefined && typeof search !== "string") ||
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    offset === null ||
    offset < 0
  ) {
    return res.status(400).json({ message: "Invalid transaction filters" });
  }

  const conditions = ["t.user_id = $1"];
  const values = [req.userId];
  let index = 2;

  if (startDate) {
    conditions.push(`t.transaction_date >= $${index++}`);
    values.push(startDate);
  }
  if (endDate) {
    conditions.push(`t.transaction_date <= $${index++}`);
    values.push(endDate);
  }
  if (parsedCategoryId !== undefined) {
    conditions.push(`t.category_id = $${index++}`);
    values.push(parsedCategoryId);
  }
  if (type) {
    conditions.push(`t.type = $${index++}`);
    values.push(type);
  }
  if (search?.trim()) {
    conditions.push(
      `(t.description ILIKE $${index} OR t.notes ILIKE $${index})`,
    );
    values.push(`%${search.trim()}%`);
    index += 1;
  }

  values.push(limit, offset);

  try {
    const result = await pool.query(
      `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.transaction_date DESC, t.id DESC
       LIMIT $${index} OFFSET $${index + 1}`,
      values,
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("GetTransactions error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const createTransaction = async (req, res) => {
  const {
    categoryId,
    amount,
    type,
    description,
    notes,
    transactionDate,
  } = req.body ?? {};

  if (amount === undefined || !type || !transactionDate) {
    return res.status(400).json({
      message: "Amount, type, and transactionDate are required",
    });
  }

  const amountString = String(amount);
  if (
    !/^\d+(?:\.\d{1,2})?$/.test(amountString) ||
    !Number.isFinite(Number(amountString)) ||
    Number(amountString) <= 0 ||
    Number(amountString) >= 10_000_000_000
  ) {
    return res.status(400).json({ message: "Amount must be greater than zero" });
  }

  if (!["income", "expense"].includes(type)) {
    return res
      .status(400)
      .json({ message: "Type must be income or expense" });
  }

  if (!isValidDate(transactionDate)) {
    return res.status(400).json({ message: "Invalid transactionDate" });
  }

  const parsedCategoryId =
    categoryId === undefined || categoryId === null || categoryId === ""
      ? null
      : parseInteger(String(categoryId), null);

  if (categoryId != null && categoryId !== "" && (!parsedCategoryId || parsedCategoryId < 1)) {
    return res.status(400).json({ message: "Invalid categoryId" });
  }

  if (
    (description != null &&
      (typeof description !== "string" || description.length > 255)) ||
    (notes != null && typeof notes !== "string")
  ) {
    return res.status(400).json({ message: "Invalid description or notes" });
  }

  try {
    if (parsedCategoryId !== null) {
      const categoryResult = await pool.query(
        "SELECT id FROM categories WHERE id = $1 AND user_id = $2 AND type = $3",
        [parsedCategoryId, req.userId, type],
      );
      if (categoryResult.rows.length === 0) {
        return res.status(400).json({ message: "Invalid category for this transaction" });
      }
    }

    const result = await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, amount, type, description, notes, transaction_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.userId,
        parsedCategoryId,
        amountString,
        type,
        description || null,
        notes || null,
        transactionDate,
      ],
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("CreateTransaction error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const getTransactionById = async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({ message: "Invalid transaction ID" });
  }

  try {
    const result = await pool.query(
      `SELECT t.*,
              c.name AS category_name,
              c.icon AS category_icon,
              c.color AS category_color
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.id = $1 AND t.user_id = $2`,
      [Number(id), req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error("GetTransactionById error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const updateTransaction = async (req, res) => {
  const { id } = req.params;
  const {
    categoryId,
    amount,
    type,
    description,
    notes,
    transactionDate,
  } = req.body ?? {};

  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({ message: "Invalid transaction ID" });
  }

  const fields = [];
  const values = [];
  let index = 1;
  let nextType = type;
  let nextCategoryId;

  if (amount !== undefined) {
    const amountString = String(amount);
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(amountString) ||
      !Number.isFinite(Number(amountString)) ||
      Number(amountString) <= 0 ||
      Number(amountString) >= 10_000_000_000
    ) {
      return res.status(400).json({ message: "Amount must be greater than zero" });
    }
    fields.push(`amount = $${index++}`);
    values.push(amountString);
  }

  if (type !== undefined) {
    if (!["income", "expense"].includes(type)) {
      return res
        .status(400)
        .json({ message: "Type must be income or expense" });
    }
    fields.push(`type = $${index++}`);
    values.push(type);
  }

  if (transactionDate !== undefined) {
    if (!isValidDate(transactionDate)) {
      return res.status(400).json({ message: "Invalid transactionDate" });
    }
    fields.push(`transaction_date = $${index++}`);
    values.push(transactionDate);
  }

  if (description !== undefined) {
    if (description !== null && (typeof description !== "string" || description.length > 255)) {
      return res.status(400).json({ message: "Invalid description" });
    }
    fields.push(`description = $${index++}`);
    values.push(description || null);
  }

  if (notes !== undefined) {
    if (notes !== null && typeof notes !== "string") {
      return res.status(400).json({ message: "Invalid notes" });
    }
    fields.push(`notes = $${index++}`);
    values.push(notes || null);
  }

  if (categoryId !== undefined) {
    nextCategoryId =
      categoryId === null || categoryId === ""
        ? null
        : parseInteger(String(categoryId), null);
    if (categoryId !== null && categoryId !== "" && (!nextCategoryId || nextCategoryId < 1)) {
      return res.status(400).json({ message: "Invalid categoryId" });
    }
    fields.push(`category_id = $${index++}`);
    values.push(nextCategoryId);
  }

  if (fields.length === 0) {
    return res.status(400).json({ message: "No transaction fields provided" });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const currentResult = await client.query(
        "SELECT type, category_id FROM transactions WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [Number(id), req.userId],
      );
      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Transaction not found" });
      }

      const current = currentResult.rows[0];
      const effectiveType = nextType ?? current.type;
      const effectiveCategoryId =
        nextCategoryId === undefined ? current.category_id : nextCategoryId;

      if (effectiveCategoryId !== null) {
        const categoryResult = await client.query(
          "SELECT id FROM categories WHERE id = $1 AND user_id = $2 AND type = $3",
          [effectiveCategoryId, req.userId, effectiveType],
        );
        if (categoryResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ message: "Invalid category for this transaction" });
        }
      }

      values.push(Number(id), req.userId);
      const result = await client.query(
        `UPDATE transactions
         SET ${fields.join(", ")}
         WHERE id = $${index++} AND user_id = $${index}
         RETURNING *`,
        values,
      );
      await client.query("COMMIT");
      return res.json(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("UpdateTransaction error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const deleteTransaction = async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({ message: "Invalid transaction ID" });
  }

  try {
    const result = await pool.query(
      "DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING id",
      [Number(id), req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    return res.json({ message: "Transaction deleted" });
  } catch (error) {
    console.error("DeleteTransaction error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const analyzeTransactions = async (req, res) => {
  const { transactionIds } = req.body ?? {};

  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    return res
      .status(400)
      .json({ message: "transactionIds array is required" });
  }

  if (
    transactionIds.some(
      (id) => !Number.isSafeInteger(id) || id < 1,
    )
  ) {
    return res
      .status(400)
      .json({ message: "transactionIds must contain valid transaction IDs" });
  }

  const ids = [...new Set(transactionIds)].slice(0, 50);

  try {
    const result = await pool.query(
      `SELECT
         t.id,
         t.amount,
         t.type,
         t.description,
         t.transaction_date,
         c.name AS category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1 AND t.id = ANY($2::int[])
       ORDER BY t.transaction_date DESC`,
      [req.userId, ids],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ message: "No transactions found for analysis" });
    }

    if (result.rows.length !== ids.length) {
      return res
        .status(404)
        .json({ message: "One or more transactions were not found" });
    }

    const userResult = await pool.query(
      "SELECT currency FROM users WHERE id = $1",
      [req.userId],
    );
    const currency = userResult.rows[0]?.currency || "USD";

    const analysis = await analyzeTransactionList({
      transactions: result.rows,
      currency,
    });

    return res.json(analysis);
  } catch (error) {
    console.error("AnalyzeTransactions error:", error);
    return res
      .status(500)
      .json({ message: error.message || "Server error" });
  }
};
