import pool from "../db.js";
import { analyzeBudgetList } from "../utils/gemini.js";

export const getBudgets = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         b.id,
         b.category_id,
         b.amount,
         b.period,
         b.start_date,
         c.name AS category_name,
         c.icon AS category_icon,
         c.color AS category_color,
         COALESCE(SUM(t.amount), 0) AS spent
       FROM budgets b
       JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id
       LEFT JOIN transactions t
         ON t.category_id = b.category_id
         AND t.user_id = b.user_id
         AND t.type = 'expense'
         AND (
           (b.period = 'monthly' AND t.transaction_date >= date_trunc('month', CURRENT_DATE))
           OR (b.period = 'weekly' AND t.transaction_date >= date_trunc('week', CURRENT_DATE))
         )
       WHERE b.user_id = $1
       GROUP BY b.id, c.name, c.icon, c.color
       ORDER BY c.name`,
      [req.userId],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("GetBudgets error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const createBudget = async (req, res) => {
  const { categoryId, amount, period = "monthly", startDate } = req.body ?? {};
  const parsedCategoryId =
    typeof categoryId === "number" && Number.isSafeInteger(categoryId)
      ? categoryId
      : typeof categoryId === "string" && /^\d+$/.test(categoryId)
        ? Number(categoryId)
        : null;
  const amountString = String(amount ?? "");

  if (
    parsedCategoryId === null ||
    parsedCategoryId < 1 ||
    amount === undefined ||
    amount === null ||
    amount === ""
  ) {
    return res
      .status(400)
      .json({ message: "categoryId and amount are required" });
  }

  if (!["monthly", "weekly"].includes(period)) {
    return res
      .status(400)
      .json({ message: "Period must be monthly or weekly" });
  }

  if (
    !/^\d+(?:\.\d{1,2})?$/.test(amountString) ||
    !Number.isFinite(Number(amountString)) ||
    Number(amountString) <= 0 ||
    Number(amountString) >= 10_000_000_000
  ) {
    return res
      .status(400)
      .json({ message: "Amount must be greater than zero" });
  }

  const today = new Date();
  const defaultStartDate = `${today.getFullYear()}-${String(
    today.getMonth() + 1,
  ).padStart(2, "0")}-01`;
  const effectiveStartDate = startDate ?? defaultStartDate;

  if (
    typeof effectiveStartDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveStartDate) ||
    Number.isNaN(Date.parse(`${effectiveStartDate}T00:00:00Z`)) ||
    new Date(`${effectiveStartDate}T00:00:00Z`).toISOString().slice(0, 10) !==
      effectiveStartDate
  ) {
    return res.status(400).json({ message: "Invalid startDate" });
  }

  try {
    const categoryResult = await pool.query(
      "SELECT id FROM categories WHERE id = $1 AND user_id = $2 AND type = 'expense'",
      [parsedCategoryId, req.userId],
    );
    if (categoryResult.rows.length === 0) {
      return res.status(400).json({ message: "Invalid expense category" });
    }

    const result = await pool.query(
      `INSERT INTO budgets (user_id, category_id, amount, period, start_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.userId, parsedCategoryId, amountString, period, effectiveStartDate],
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({
          message: "Budget already exists for this category and period",
        });
    }

    console.error("CreateBudget error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const updateBudget = async (req, res) => {
  const { id } = req.params;
  const { amount, period } = req.body ?? {};

  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({ message: "Invalid budget ID" });
  }

  if (amount === undefined && period === undefined) {
    return res.status(400).json({ message: "Amount or period is required" });
  }

  let amountString;
  if (amount !== undefined) {
    amountString = String(amount);
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(amountString) ||
      !Number.isFinite(Number(amountString)) ||
      Number(amountString) <= 0 ||
      Number(amountString) >= 10_000_000_000
    ) {
      return res.status(400).json({ message: "Amount must be greater than zero" });
    }
  }

  if (period !== undefined && !["monthly", "weekly"].includes(period)) {
    return res
      .status(400)
      .json({ message: "Period must be monthly or weekly" });
  }

  try {
    const result = await pool.query(
      `UPDATE budgets
       SET amount = COALESCE($1, amount),
           period = COALESCE($2, period)
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [amountString ?? null, period ?? null, Number(id), req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Budget not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ message: "Budget already exists for this category and period" });
    }

    console.error("UpdateBudget error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const deleteBudget = async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id) || Number(id) < 1 || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({ message: "Invalid budget ID" });
  }

  try {
    const result = await pool.query(
      "DELETE FROM budgets WHERE id = $1 AND user_id = $2 RETURNING id",
      [Number(id), req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Budget not found" });
    }

    return res.json({ message: "Budget deleted" });
  } catch (error) {
    console.error("DeleteBudget error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const analyzeBudgets = async (req, res) => {
  try {
    const [budgetsResult, userResult] = await Promise.all([
      pool.query(
        `SELECT
           b.id,
           b.category_id,
           b.amount,
           b.period,
           b.start_date,
           c.name AS category_name,
           COALESCE(SUM(t.amount), 0) AS spent
         FROM budgets b
         JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id
         LEFT JOIN transactions t
           ON t.category_id = b.category_id
           AND t.user_id = b.user_id
           AND t.type = 'expense'
           AND (
             (b.period = 'monthly' AND t.transaction_date >= date_trunc('month', CURRENT_DATE))
             OR (b.period = 'weekly' AND t.transaction_date >= date_trunc('week', CURRENT_DATE))
           )
         WHERE b.user_id = $1
         GROUP BY b.id, c.name
         ORDER BY c.name`,
        [req.userId],
      ),
      pool.query("SELECT currency FROM users WHERE id = $1", [req.userId]),
    ]);

    const analysis = await analyzeBudgetList({
      budgets: budgetsResult.rows,
      currency: userResult.rows[0]?.currency || "USD",
    });

    return res.json(analysis);
  } catch (error) {
    console.error("AnalyzeBudgets error:", error);
    return res
      .status(500)
      .json({ message: error.message || "Server error" });
  }
};
