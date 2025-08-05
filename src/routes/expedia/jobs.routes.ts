import express from "express";
import { jobService } from "../../services/job.service.js";

const router = express.Router();

/**
 * @swagger
 * /api/jobs/{jobId}/progress:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job progress
 *     description: Get detailed progress information for a specific job including scraped data statistics
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The job ID to get progress for
 *         example: "507f1f77bcf86cd799439011"
 *     responses:
 *       200:
 *         description: Job progress retrieved successfully
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
 *                   example: "Job progress retrieved successfully"
 *                 job:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                     property_name:
 *                       type: string
 *                     portfolio_name:
 *                       type: string
 *                 progress:
 *                   type: object
 *                   properties:
 *                     totalItems:
 *                       type: integer
 *                     itemsWithCardInfo:
 *                       type: integer
 *                     itemsWithPaymentInfo:
 *                       type: integer
 *                     completionPercentage:
 *                       type: integer
 *       404:
 *         description: Job not found
 *       500:
 *         description: Server error
 */
router.get("/:jobId/progress", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;

    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: "Job not found",
      });
    }

    const progress = await jobService.getJobProgress(jobId);
    const items = await jobService.getJobItems(jobId, 10); // Last 10 items

    res.status(200).json({
      status: 200,
      message: "Job progress retrieved successfully",
      job: {
        id: job._id,
        status: job.job_status,
        property_name: job.property_name,
        portfolio_name: job.portfolio_name,
      },
      progress: progress,
      recentItems: items,
    });
  } catch (err: any) {
    console.error("Error getting job progress:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job progress",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/jobs/{jobId}/items:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job items
 *     description: Get scraped reservation data for a specific job
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The job ID to get items for
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of items to return per page
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: createdAt
 *         description: Field to sort by (e.g., guest_name, reservation_id, createdAt, etc.)
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order (asc or desc)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by guest name or reservation ID (partial match, case-insensitive)
 *       - in: query
 *         name: reasonForCharge
 *         schema:
 *           type: string
 *         description: Filter by reason for charge (partial match, case-insensitive)
 *     responses:
 *       200:
 *         description: Job items retrieved successfully
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
 *                   example: "Job items retrieved successfully"
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       guest_name:
 *                         type: string
 *                       reservation_id:
 *                         type: string
 *                       confirmation_number:
 *                         type: string
 *                       check_in_date:
 *                         type: string
 *                         format: date
 *                       check_out_date:
 *                         type: string
 *                         format: date
 *                       room_type:
 *                         type: string
 *                       booking_amount:
 *                         type: number
 *                       has_card_info:
 *                         type: boolean
 *                       has_payment_info:
 *                         type: boolean
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     totalDocuments:
 *                       type: integer
 *                     currentPage:
 *                       type: integer
 *                     totalPage:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *       404:
 *         description: Job not found
 *       500:
 *         description: Server error
 */
router.get("/:jobId/items", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;
    const {
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
      search,
      reasonForCharge,
    } = req.query;

    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: "Job not found",
      });
    }

    const result = await jobService.getJobItemsAdvanced({
      jobId,
      page: parseInt(page as string, 10),
      limit: parseInt(limit as string, 10),
      sortBy: sortBy as string,
      sortOrder: (sortOrder as string) === "asc" ? "asc" : "desc",
      search: search as string,
      reasonForCharge: reasonForCharge as string,
    });

    res.status(200).json({
      status: 200,
      message: "Job items retrieved successfully",
      items: result.items,
      metadata: {
        totalDocuments: result.totalDocuments,
        currentPage: result.currentPage,
        totalPage: result.totalPage,
        limit: result.limit,
      },
    });
  } catch (err: any) {
    console.error("Error getting job items:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job items",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/jobs/{jobId}/log:
 *   get:
 *     tags:
 *       - Job Monitoring
 *     summary: Get job log link
 *     description: Get the S3 URL for the job's log file
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The job ID to get log link for
 *     responses:
 *       200:
 *         description: Job log link retrieved successfully
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
 *                   example: "Job log link retrieved successfully"
 *                 job:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                     property_name:
 *                       type: string
 *                     log_link:
 *                       type: string
 *                       description: S3 URL of the job log file
 *       404:
 *         description: Job not found or no log available
 *       500:
 *         description: Server error
 */
router.get("/:jobId/log", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { jobId } = req.params;

    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        status: 404,
        message: "Job not found",
      });
    }

    if (!job.log_link) {
      return res.status(404).json({
        status: 404,
        message: "No log file available for this job",
      });
    }

    res.status(200).json({
      status: 200,
      message: "Job log link retrieved successfully",
      job: {
        id: job._id,
        status: job.job_status,
        property_name: job.property_name,
        log_link: job.log_link,
      },
    });
  } catch (err: any) {
    console.error("Error getting job log link:", err);
    res.status(500).json({
      status: 500,
      message: "Error retrieving job log link",
      error: err.message,
    });
  }
}) as any);

export default router;
