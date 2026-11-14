import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

export const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

if (!ai) {
  console.error(
    "WARNING: GEMINI_API_KEY is not set. AI features will not work.",
  );
}

export const stripMarkdown = (text) => {
  let cleaned = text.trim();

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\n?/i, "").replace(/```\n?$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\n?/, "").replace(/```\n?$/, "");
  }

  return cleaned.trim();
};

const generateJson = async (prompt, featureName) => {
  if (!ai) {
    throw new Error("GEMINI_API_KEY is required for AI features.");
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    if (typeof response.text !== "string" || !response.text.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    return JSON.parse(stripMarkdown(response.text));
  } catch (error) {
    console.error(`Gemini API error (${featureName}):`, error);
    throw new Error(`Failed to generate ${featureName}. Please try again.`, {
      cause: error,
    });
  }
};

const formatAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
};

export const generateMonthlyInsight = async ({
  totalIncome,
  totalExpenses,
  savingsRate,
  expenseBreakdown = [],
  previousMonths = [],
  currency = "USD",
}) => {
  const breakdownText =
    expenseBreakdown.length > 0
      ? expenseBreakdown
          .map(
            (category) =>
              `- ${category.category}: ${currency} ${formatAmount(category.amount)}`,
          )
          .join("\n")
      : "- No expenses recorded yet";
  const trendText =
    previousMonths.length > 0
      ? previousMonths
          .map(
            (month) =>
              `- ${month.month}: Income ${currency} ${formatAmount(month.income)}, Expenses ${currency} ${formatAmount(month.expense)}`,
          )
          .join("\n")
      : "- No previous month data available";

  const prompt = `Analyze this user's monthly financial data and generate actionable insights.

Currency: ${currency}
Total Income (this month): ${currency} ${formatAmount(totalIncome)}
Total Expenses (this month): ${currency} ${formatAmount(totalExpenses)}
Savings Rate: ${formatAmount(savingsRate)}%

Expense breakdown by category (this month):
${breakdownText}

Previous months trend:
${trendText}

Return ONLY valid JSON (no markdown, no commentary) in this exact structure:
{
  "summary": "2-3 sentence summary of the user's financial health this month",
  "highlights": ["Positive observation 1", "Positive observation 2"],
  "concerns": ["Concern 1", "Concern 2"],
  "recommendations": [
    {"title": "Short title", "detail": "Actionable suggestion (1-2 sentences)"}
  ],
  "topSpendingCategory": "Category name or null",
  "estimatedMonthlySavings": 0,
  "healthScore": 50
}

Constraints:
- healthScore must be an integer between 0 and 100.
- Provide 3 recommendations.
- Reference actual numbers from the data. Tone: friendly but honest.`;

  return generateJson(prompt, "monthly insight");
};

export const generateSavingsTips = async ({
  topCategories = [],
  monthlyIncome,
  currency = "USD",
}) => {
  const categoryText =
    topCategories.length > 0
      ? topCategories
          .map(
            (category) =>
              `- ${category.category}: ${currency} ${formatAmount(category.amount)} across ${category.transactionCount} transactions`,
          )
          .join("\n")
      : "- No spending data available";

  const prompt = `Generate personalized savings tips for a user.

Monthly Income (last 30 days): ${currency} ${formatAmount(monthlyIncome)}
Top spending categories (last 30 days):
${categoryText}

Return ONLY valid JSON (no markdown):
{
  "overallTip": "Top-level 1-sentence advice",
  "tips": [
    {
      "category": "Category this targets",
      "title": "Short tip title",
      "detail": "2-3 sentence actionable suggestion",
      "estimatedSavings": 0
    }
  ]
}

Provide exactly 4 tips. Each tip should reference an actual category from the data and include a realistic monthly estimatedSavings amount as a number.`;

  return generateJson(prompt, "savings tips");
};

export const analyzeTransactionList = async ({
  transactions = [],
  currency = "USD",
}) => {
  const formatDate = (date) => {
    if (!date) return "";
    if (date instanceof Date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    return String(date).split("T")[0];
  };

  const lines = transactions
    .slice(0, 50)
    .map((transaction) => {
      const date = formatDate(transaction.transaction_date);
      const amount = formatAmount(transaction.amount);
      const category = transaction.category_name || "uncategorized";
      const description = transaction.description
        ? ` | ${transaction.description}`
        : "";
      return `- ${date}: ${transaction.type} ${currency} ${amount} | ${category}${description}`;
    })
    .join("\n");

  const prompt = `Analyze these ${transactions.length} transactions and provide a concise, helpful spending insight.

Transactions:
${lines || "- No transactions provided"}

Return ONLY valid JSON (no markdown):
{
  "insight": "2-4 sentence analysis with specific numbers from the data. Tone: friendly, helpful.",
  "highlight": "Single short phrase capturing the key takeaway (e.g., 'Heavy on dining', 'Stable income')"
}`;

  return generateJson(prompt, "transaction analysis");
};

export const analyzeBudgetList = async ({ budgets = [], currency = "USD" }) => {
  const lines = budgets
    .map((budget) => {
      const spent = Number(budget.spent);
      const total = Number(budget.amount);
      const percent = total > 0 ? ((spent / total) * 100).toFixed(1) : "0";
      return `- Budget ID ${budget.id} | Category: ${budget.category_name} | Limit: ${currency} ${formatAmount(total)} | Spent: ${currency} ${formatAmount(spent)} (${percent}%)`;
    })
    .join("\n");

  const prompt = `You're a personal finance assistant. Analyze each budget below and provide a one-sentence status and message.

Today: ${new Date().toISOString().split("T")[0]}
Currency: ${currency}
Budgets:
${lines || "- No budgets available"}

For each budget, return:
- status: 'good' (well-paced, under target), 'caution' (approaching limit or above 70%), or 'concerning' (over limit)
- message: A specific, friendly 1-sentence assessment with actionable feedback or encouragement

Return ONLY valid JSON (no markdown):
{
  "analyses": [
    { "budgetId": 1, "status": "good", "message": "string" }
  ]
}`;

  return generateJson(prompt, "budget analysis");
};

export const generateBudgetAlert = async ({
  categoryName,
  budgetAmount,
  spentAmount,
  daysIntoPeriod,
  totalPeriodDays,
  currency = "USD",
}) => {
  const prompt = `Assess this user's budget and return one short, helpful alert.

Category: ${categoryName}
Budget limit: ${currency} ${formatAmount(budgetAmount)}
Amount spent: ${currency} ${formatAmount(spentAmount)}
Days elapsed in the budget period: ${daysIntoPeriod} of ${totalPeriodDays}

Return ONLY valid JSON (no markdown):
{
  "status": "good",
  "message": "A specific, friendly one-sentence assessment with actionable feedback or encouragement"
}

Use status "good" when spending is well-paced and under target, "caution" when approaching the limit or spending more than 70% of the limit, and "concerning" when over the limit.`;

  return generateJson(prompt, "budget alert");
};

export default {
  generateMonthlyInsight,
  generateBudgetAlert,
  generateSavingsTips,
  analyzeTransactionList,
  analyzeBudgetList,
};
