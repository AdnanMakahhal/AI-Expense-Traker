import pool from "../db.js";
import { generateSavingsTips } from "../utils/gemini.js";

export const getCategories = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM categories WHERE user_id = $1 ORDER BY type, name",
      [req.userId],
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("GetCategories error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const createCategory = async (req, res) => {
  const { name, type, icon, color } = req.body ?? {};
  const normalizedName = typeof name === "string" ? name.trim() : "";

  if (!normalizedName || !type) {
    return res.status(400).json({ message: "Name and type are required" });
  }

  if (!["income", "expense"].includes(type)) {
    return res.status(400).json({ message: "Type must be income or expense" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO categories (user_id, name, type, icon, color, is_default)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING *`,
      [req.userId, normalizedName, type, icon || null, color || null],
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ message: "Category with this name already exists" });
    }

    console.error("CreateCategory error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { name, icon, color } = req.body ?? {};
  const normalizedName = typeof name === "string" ? name.trim() : name;

  try {
    const result = await pool.query(
      `UPDATE categories
       SET name = COALESCE($1, name),
           icon = COALESCE($2, icon),
           color = COALESCE($3, color)
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [normalizedName, icon, color, id, req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ message: "Category with this name already exists" });
    }

    console.error("UpdateCategory error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const deleteCategory = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM categories WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Category not found" });
    }

    return res.json({ message: "Category deleted" });
  } catch (error) {
    console.error("DeleteCategory error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const analyzeCategories = async (req, res) => {
  try {
    const [categoriesResult, incomeResult, userResult] = await Promise.all([
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
        [req.userId],
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS income
         FROM transactions
         WHERE user_id = $1
           AND type = 'income'
           AND transaction_date >= CURRENT_DATE - INTERVAL '30 days'`,
        [req.userId],
      ),
      pool.query("SELECT currency FROM users WHERE id = $1", [req.userId]),
    ]);

    if (categoriesResult.rows.length === 0) {
      return res.json({
        overallTip: "Record some expenses to get personalized category insights.",
        tips: [],
      });
    }

    const analysis = await generateSavingsTips({
      topCategories: categoriesResult.rows.map((row) => ({
        category: row.category,
        amount: Number.parseFloat(row.amount) || 0,
        transactionCount: Number.parseInt(row.count, 10) || 0,
      })),
      monthlyIncome: Number.parseFloat(incomeResult.rows[0].income) || 0,
      currency: userResult.rows[0]?.currency || "USD",
    });

    return res.json(analysis);
  } catch (error) {
    console.error("AnalyzeCategories error:", error);
    return res
      .status(500)
      .json({ message: error.message || "Server error" });
  }
};
