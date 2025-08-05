import express from "express";
import { getAccess, getOauth2Callback } from "../../get-access/access.js";

const router = express.Router();

/**
 * @swagger
 * /auth:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Initiate OAuth authentication
 *     description: Start the OAuth authentication flow for accessing Expedia services
 *     responses:
 *       200:
 *         description: Authentication flow initiated
 *       500:
 *         description: Authentication error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/auth", getAccess as any);

/**
 * @swagger
 * /oauth2callback:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: OAuth callback endpoint
 *     description: Handle OAuth callback after user authentication
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code from OAuth provider
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State parameter for security
 *     responses:
 *       200:
 *         description: OAuth callback processed successfully
 *       400:
 *         description: Invalid OAuth callback parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/oauth2callback", getOauth2Callback as any);

export default router;
