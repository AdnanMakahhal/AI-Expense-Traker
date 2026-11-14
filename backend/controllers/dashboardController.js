import pool from "../db.js";
import { generateMonthlyInsight } from "../utils/gemini.js";

const pctChange = (current, previous) => {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
};

export const getSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `WITH monthly AS (
         SELECT
           date_trunc('month', transaction_date)::date AS month,
           type,
           SUM(amount) AS total
         FROM transactions
         WHERE user_id = $1
           AND transaction_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
         GROUP BY 1, 2
       )
       SELECT
         COALESCE(SUM(CASE
           WHEN month = date_trunc('month', CURRENT_DATE)::date AND type = 'income'
           THEN total
         END), 0) AS income_this_month,
         COALESCE(SUM(CASE
           WHEN month = date_trunc('month', CURRENT_DATE)::date AND type = 'expense'
           THEN total
         END), 0) AS expense_this_month,
         COALESCE(SUM(CASE
           WHEN month = (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
             AND type = 'income'
           THEN total
         END), 0) AS income_last_month,
         COALESCE(SUM(CASE
           WHEN month = (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
             AND type = 'expense'
           THEN total
         END), 0) AS expense_last_month
       FROM monthly`,
      [req.userId],
    );

    const row = result.rows[0];
    const incomeThisMonth = Number.parseFloat(row.income_this_month);
    const expenseThisMonth = Number.parseFloat(row.expense_this_month);
    const incomeLastMonth = Number.parseFloat(row.income_last_month);
    const expenseLastMonth = Number.parseFloat(row.expense_last_month);
    const balance = incomeThisMonth - expenseThisMonth;
    const savingsRate =
      incomeThisMonth > 0 ? (balance / incomeThisMonth) * 100 : 0;

    return res.json({
      incomeThisMonth,
      expenseThisMonth,
      balance,
      savingsRate,
      incomeDelta: pctChange(incomeThisMonth, incomeLastMonth),
      expenseDelta: pctChange(expenseThisMonth, expenseLastMonth),
    });
  } catch (error) {
    console.error("GetSummary error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const getCategoryBreakdown = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.id AS category_id,
         c.name AS category_name,
         c.icon AS category_icon,
         c.color AS category_color,
         SUM(t.amount) AS total,
         COUNT(t.id) AS transaction_count
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.transaction_date >= date_trunc('month', CURRENT_DATE)
       GROUP BY c.id
       ORDER BY total DESC`,
      [req.userId],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("GetCategoryBreakdown error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const getMonthlyTrend = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         to_char(date_trunc('month', transaction_date), 'YYYY-MM') AS month,
         SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense
       FROM transactions
       WHERE user_id = $1
         AND transaction_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
       GROUP BY 1
       ORDER BY 1`,
      [req.userId],
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("GetMonthlyTrend error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const analyzeDashboard = async (req, res) => {
  try {
    const [summaryResult, breakdownResult, trendResult, userResult] =
      await Promise.all([
        pool.query(
          `SELECT
             COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0) AS income,
             COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expenses
           FROM transactions
           WHERE user_id = $1
             AND transaction_date >= date_trunc('month', CURRENT_DATE)`,
          [req.userId],
        ),
        pool.query(
          `SELECT c.name AS category, SUM(t.amount) AS amount
           FROM transactions t
           JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id
           WHERE t.user_id = $1
             AND t.type = 'expense'
             AND t.transaction_date >= date_trunc('month', CURRENT_DATE)
           GROUP BY c.name
           ORDER BY amount DESC`,
          [req.userId],
        ),
        pool.query(
          `SELECT
             to_char(date_trunc('month', transaction_date), 'YYYY-MM') AS month,
             SUM(amount) FILTER (WHERE type = 'income') AS income,
             SUM(amount) FILTER (WHERE type = 'expense') AS expense
           FROM transactions
           WHERE user_id = $1
             AND transaction_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
             AND transaction_date < date_trunc('month', CURRENT_DATE)
           GROUP BY 1
           ORDER BY 1`,
          [req.userId],
        ),
        pool.query("SELECT currency FROM users WHERE id = $1", [req.userId]),
      ]);

    const totalIncome = Number.parseFloat(summaryResult.rows[0].income) || 0;
    const totalExpenses = Number.parseFloat(summaryResult.rows[0].expenses) || 0;
    const analysis = await generateMonthlyInsight({
      totalIncome,
      totalExpenses,
      savingsRate:
        totalIncome > 0
          ? ((totalIncome - totalExpenses) / totalIncome) * 100
          : 0,
      expenseBreakdown: breakdownResult.rows.map((row) => ({
        category: row.category,
        amount: Number.parseFloat(row.amount) || 0,
      })),
      previousMonths: trendResult.rows.map((row) => ({
        month: row.month,
        income: Number.parseFloat(row.income) || 0,
        expense: Number.parseFloat(row.expense) || 0,
      })),
      currency: userResult.rows[0]?.currency || "USD",
    });

    return res.json(analysis);
  } catch (error) {
    console.error("AnalyzeDashboard error:", error);
    return res
      .status(500)
      .json({ message: error.message || "Server error" });
  }
};
