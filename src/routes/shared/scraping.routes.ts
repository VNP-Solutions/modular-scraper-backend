import express from "express";
import { scrapingStateManager } from "../../common/scraping-state.js";

const router = express.Router();

/**
 * @swagger
 * /api/scraping/status:
 *   get:
 *     tags:
 *       - Scraping Control
 *     summary: Get current scraping status
 *     description: Retrieve the current state and progress of scraping operations
 *     responses:
 *       200:
 *         description: Scraping status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Scraping status retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       500:
 *         description: Error retrieving scraping status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to get scraping status
router.get("/status", (req: express.Request, res: express.Response) => {
  try {
    const state = scrapingStateManager.getState();
    res.status(200).json({
      status: 200,
      message: "Scraping status retrieved successfully",
      data: state,
    });
  } catch (err: any) {
    console.error("Error getting scraping status:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving scraping status",
      error: err.message,
    });
  }
});

/**
 * @swagger
 * /api/scraping/pause:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Pause current scraping job
 *     description: Gracefully pause the currently running scraping job. The current operation will complete before pausing.
 *     responses:
 *       200:
 *         description: Scraping paused successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Scraping paused successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       400:
 *         description: Cannot pause scraping - no active job running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "Cannot pause scraping - no active scraping job running"
 *       500:
 *         description: Error pausing scraping
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to pause scraping
router.post("/pause", (req: express.Request, res: express.Response) => {
  try {
    const success = scrapingStateManager.pauseScraping();

    if (success) {
      res.status(200).json({
        status: 200,
        message: "Scraping paused successfully",
        data: scrapingStateManager.getState(),
      });
    } else {
      res.status(400).json({
        status: 400,
        message: "Cannot pause scraping - no active scraping job running",
      });
    }
  } catch (err: any) {
    console.error("Error pausing scraping:", err);
    res.status(500).json({
      status: 500,
      message: "Error pausing scraping",
      error: err.message,
    });
  }
});

/**
 * @swagger
 * /api/scraping/resume:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Resume paused scraping job
 *     description: Resume a previously paused scraping job from where it left off
 *     responses:
 *       200:
 *         description: Scraping resumed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Scraping resumed successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       400:
 *         description: Cannot resume scraping - no paused job found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: "Cannot resume scraping - no paused scraping job found"
 *       500:
 *         description: Error resuming scraping
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to resume scraping
router.post("/resume", (req: express.Request, res: express.Response) => {
  try {
    const success = scrapingStateManager.resumeScraping();

    if (success) {
      res.status(200).json({
        status: 200,
        message: "Scraping resumed successfully",
        data: scrapingStateManager.getState(),
      });
    } else {
      res.status(400).json({
        status: 400,
        message: "Cannot resume scraping - no paused scraping job found",
      });
    }
  } catch (err: any) {
    console.error("Error resuming scraping:", err);
    res.status(500).json({
      status: 500,
      message: "Error resuming scraping",
      error: err.message,
    });
  }
});

/**
 * @swagger
 * /api/scraping/stop:
 *   post:
 *     tags:
 *       - Scraping Control
 *     summary: Stop current scraping job
 *     description: Completely stop the current scraping job. This cannot be resumed and will require starting a new job.
 *     responses:
 *       200:
 *         description: Scraping stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: "Scraping stopped successfully"
 *                 data:
 *                   $ref: '#/components/schemas/ScrapingState'
 *       500:
 *         description: Error stopping scraping
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// API to stop scraping
router.post("/stop", (req: express.Request, res: express.Response) => {
  try {
    const wasRunning = scrapingStateManager.isRunning();
    scrapingStateManager.stopScraping();

    if (wasRunning) {
      res.status(200).json({
        status: 200,
        message: "Scraping stopped successfully",
        data: scrapingStateManager.getState(),
      });
    } else {
      res.status(200).json({
        status: 200,
        message: "No scraping job was running",
        data: scrapingStateManager.getState(),
      });
    }
  } catch (err: any) {
    console.error("Error stopping scraping:", err);
    res.status(500).json({
      status: 500,
      message: "Error stopping scraping",
      error: err.message,
    });
  }
});

export default router;
