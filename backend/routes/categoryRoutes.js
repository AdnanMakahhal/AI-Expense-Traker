import express from "express";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  analyzeCategories,
} from "../controllers/categoryController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.post("/analyze", analyzeCategories);
router.get("/", getCategories);
router.post("/", createCategory);
router.put("/:id", updateCategory);
router.delete("/:id", deleteCategory);

export default router;