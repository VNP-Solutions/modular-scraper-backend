import express from "express";
import createError from "../../common/error.js";

const router = express.Router();

/**
 * @swagger
 * /:
 *   get:
 *     tags:
 *       - Health
 *     summary: Health check endpoint
 *     description: Check if the server is running and accessible
 *     responses:
 *       200:
 *         description: Server is running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 messge:
 *                   type: string
 *                   example: "Connection established"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to check connection to servers (health api)
router.get("/", (req, res, next) => {
  try {
    res
      .status(200)
      .json({ messge: "Connection established on agoda-thread branch" });
  } catch (err: any) {
    next(createError(err.status, err.message));
  }
});

export default router;
