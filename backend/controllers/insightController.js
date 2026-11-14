import pool from "../db.js";
import {
  generateMonthlyInsight,
  generateBudgetAlert,
  generateSavingsTips,
} from "../utils/gemini.js";

const getUserCurrency = async (userId) => {
  const result = await pool.query("SELECT currency FROM users WHERE id = $1", [
    userId,
  ]);
  return result.rows[0]?.currency || "USD";
};

const buildMonthlyInsight = async (userId) => {
  const result = await pool.query(
    `WITH current_month AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0) AS income,
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expense
       FROM transactions
       WHERE user_id = $1
         AND transaction_date >= date_trunc('month', CURRENT_DATE)
     ),
     breakdown AS (
       SELECT c.name AS category, SUM(t.amount) AS amount
       FROM transactions t
       JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.transaction_date >= date_trunc('month', CURRENT_DATE)
       GROUP BY c.name
       ORDER BY amount DESC
     ),
     trend AS (
       SELECT
         to_char(date_trunc('month', transaction_date), 'YYYY-MM') AS month,
         SUM(amount) FILTER (WHERE type = 'income') AS income,
         SUM(amount) FILTER (WHERE type = 'expense') AS expenses
       FROM transactions
       WHERE user_id = $1
         AND transaction_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
         AND transaction_date < date_trunc('month', CURRENT_DATE)
       GROUP BY 1
       ORDER BY 1
     )
     SELECT
       (SELECT income FROM current_month) AS income,
       (SELECT expense FROM current_month) AS expense,
       COALESCE((SELECT json_agg(breakdown) FROM breakdown), '[]'::json) AS breakdown,
       COALESCE((SELECT json_agg(trend) FROM trend), '[]'::json) AS trend`,
    [userId],
  );

  const row = result.rows[0];
  const totalIncome = Number.parseFloat(row.income) || 0;
  const totalExpenses = Number.parseFloat(row.expense) || 0;
  const savingsRate =
    totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;
  const currency = await getUserCurrency(userId);
  const content = await generateMonthlyInsight({
    totalIncome,
    totalExpenses,
    savingsRate,
    expenseBreakdown: row.breakdown.map((item) => ({
      category: item.category,
      amount: Number.parseFloat(item.amount) || 0,
    })),
    previousMonths: row.trend.map((item) => ({
      month: item.month,
      income: Number.parseFloat(item.income) || 0,
      expense: Number.parseFloat(item.expenses) || 0,
    })),
    currency,
  });

  const now = new Date();
  const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const periodEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  return { content, periodStart, periodEnd };
};

const buildSavingsTips = async (userId) => {
  const [categoriesResult, incomeResult, currency] = await Promise.all([
    pool.query(
      `SELECT c.name AS category, SUM(t.amount) AS amount, COUNT(t.id) AS count
       FROM transactions t
       JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY c.name
       ORDER BY amount DESC
       LIMIT 5`,
      [userId],
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS income
       FROM transactions
       WHERE user_id = $1
         AND type = 'income'
         AND transaction_date >= CURRENT_DATE - INTERVAL '30 days'`,
      [userId],
    ),
    getUserCurrency(userId),
  ]);

  const content = await generateSavingsTips({
    topCategories: categoriesResult.rows.map((row) => ({
      category: row.category,
      amount: Number.parseFloat(row.amount) || 0,
      transactionCount: Number.parseInt(row.count, 10) || 0,
    })),
    monthlyIncome: Number.parseFloat(incomeResult.rows[0].income) || 0,
    currency,
  });

  return { content, periodStart: null, periodEnd: null };
};

const buildBudgetAlert = async (userId, categoryId) => {
  const parsedCategoryId = Number(categoryId);
  if (
    categoryId === undefined ||
    !/^\d+$/.test(String(categoryId)) ||
    !Number.isSafeInteger(parsedCategoryId) ||
    parsedCategoryId < 1
  ) {
    const error = new Error("A valid categoryId is required for budget_alert");
    error.status = 400;
    throw error;
  }

  const result = await pool.query(
    `SELECT
       b.id,
       b.amount,
       b.period,
       c.name AS category_name,
       COALESCE((
         SELECT SUM(t.amount)
         FROM transactions t
         WHERE t.user_id = b.user_id
           AND t.category_id = b.category_id
           AND t.type = 'expense'
           AND (
             (b.period = 'monthly' AND t.transaction_date >= date_trunc('month', CURRENT_DATE))
             OR (b.period = 'weekly' AND t.transaction_date >= date_trunc('week', CURRENT_DATE))
           )
       ), 0) AS spent
     FROM budgets b
     JOIN categories c ON c.id = b.category_id AND c.user_id = b.user_id
     WHERE b.user_id = $1 AND b.category_id = $2`,
    [userId, parsedCategoryId],
  );

  if (result.rows.length === 0) {
    const error = new Error("Budget not found for category");
    error.status = 404;
    throw error;
  }

  const budget = result.rows[0];
  const now = new Date();
  const daysIntoPeriod =
    budget.period === "weekly" ? ((now.getDay() + 6) % 7) + 1 : now.getDate();
  const totalPeriodDays =
    budget.period === "weekly"
      ? 7
      : new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currency = await getUserCurrency(userId);
  const content = await generateBudgetAlert({
    categoryName: budget.category_name,
    budgetAmount: Number.parseFloat(budget.amount),
    spentAmount: Number.parseFloat(budget.spent) || 0,
    daysIntoPeriod,
    totalPeriodDays,
    currency,
  });

  return { content, periodStart: null, periodEnd: null };
};

export const getInsights = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM ai_insights
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId],
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("GetInsights error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const generateInsight = async (req, res) => {
  const { type, categoryId } = req.body ?? {};

  if (!type) {
    return res.status(400).json({ message: "Insight type is required" });
  }

  try {
    let result;
    if (type === "monthly_summary") {
      result = await buildMonthlyInsight(req.userId);
    } else if (type === "savings_tips") {
      result = await buildSavingsTips(req.userId);
    } else if (type === "budget_alert") {
      result = await buildBudgetAlert(req.userId, categoryId);
    } else {
      return res.status(400).json({ message: "Unknown insight type" });
    }

    const inserted = await pool.query(
      `INSERT INTO ai_insights
         (user_id, insight_type, period_start, period_end, content_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.userId, type, result.periodStart, result.periodEnd, result.content],
    );

    return res.status(201).json(inserted.rows[0]);
  } catch (error) {
    console.error("GenerateInsight error:", error);
    return res
      .status(error.status || 500)
      .json({ message: error.message || "Server error" });
  }
};
