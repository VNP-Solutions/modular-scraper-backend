import express from "express";
import { Types } from "mongoose";
import { PlatformsType } from "../../common/booking-error-types.js";
import { Property } from "../../models/property.model.js";
import {
  cookieStorageService,
  CookieData,
} from "../../services/cookie-storage.service.js";

const router = express.Router();

function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

function parsePlatform(value: unknown): PlatformsType | null {
  if (typeof value !== "string") {
    return null;
  }
  const platform = value.toLowerCase();
  if (Object.values(PlatformsType).includes(platform as PlatformsType)) {
    return platform as PlatformsType;
  }
  return null;
}

function validateCookies(cookies: unknown): cookies is CookieData[] {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return false;
  }

  return cookies.every(
    (cookie) =>
      cookie &&
      typeof cookie === "object" &&
      typeof cookie.name === "string" &&
      cookie.name.trim() !== "" &&
      typeof cookie.value === "string"
  );
}

/**
 * @swagger
 * /api/properties/{propertyId}/cookies:
 *   get:
 *     tags:
 *       - Cookie Storage
 *     summary: Get decrypted cookies for a property
 *     description: Retrieve and decrypt stored cookies for a property and platform
 *     parameters:
 *       - in: path
 *         name: propertyId
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB property ID
 *       - in: query
 *         name: platform
 *         required: false
 *         schema:
 *           type: string
 *           enum: [booking]
 *           default: booking
 *         description: Platform to load cookies for
 *     responses:
 *       200:
 *         description: Cookies retrieved successfully
 *       404:
 *         description: Property or cookies not found
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Server error
 */
router.get("/:propertyId/cookies", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { propertyId } = req.params;
    const platform = parsePlatform(req.query.platform ?? PlatformsType.BOOKING);

    if (!isValidObjectId(propertyId)) {
      return res.status(400).json({
        status: 400,
        message: "Invalid propertyId",
      });
    }

    if (!platform) {
      return res.status(400).json({
        status: 400,
        message: `Invalid platform. Must be one of: ${Object.values(PlatformsType).join(", ")}`,
      });
    }

    const property = await Property.findById(propertyId).select("_id property_name").lean();
    if (!property) {
      return res.status(404).json({
        status: 404,
        message: `Property with ID ${propertyId} not found`,
      });
    }

    const cookies = await cookieStorageService.loadCookies(propertyId, platform);
    if (!cookies) {
      return res.status(404).json({
        status: 404,
        message: `No active cookies found for property ${propertyId} on platform ${platform}`,
      });
    }

    return res.status(200).json({
      status: 200,
      message: "Cookies retrieved successfully",
      data: {
        propertyId,
        propertyName: property.property_name,
        platform,
        cookies,
        cookieCount: cookies.length,
      },
    });
  } catch (err: any) {
    console.error("Error getting cookies:", err);
    return res.status(500).json({
      status: 500,
      message: "Error retrieving cookies",
      error: err.message,
    });
  }
}) as any);

/**
 * @swagger
 * /api/properties/{propertyId}/cookies:
 *   put:
 *     tags:
 *       - Cookie Storage
 *     summary: Create or update cookies for a property
 *     description: Encrypt and store cookies for a property and platform (upsert)
 *     parameters:
 *       - in: path
 *         name: propertyId
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB property ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - cookies
 *             properties:
 *               platform:
 *                 type: string
 *                 enum: [booking]
 *                 default: booking
 *               cookies:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required:
 *                     - name
 *                     - value
 *                   properties:
 *                     name:
 *                       type: string
 *                     value:
 *                       type: string
 *                     domain:
 *                       type: string
 *                     path:
 *                       type: string
 *                     expires:
 *                       type: number
 *                     httpOnly:
 *                       type: boolean
 *                     secure:
 *                       type: boolean
 *                     sameSite:
 *                       type: string
 *                       enum: [Strict, Lax, None]
 *     responses:
 *       200:
 *         description: Cookies saved successfully
 *       404:
 *         description: Property not found
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Server error
 */
router.put("/:propertyId/cookies", (async (
  req: express.Request,
  res: express.Response
) => {
  try {
    const { propertyId } = req.params;
    const { cookies } = req.body;
    const platform = parsePlatform(req.body.platform ?? PlatformsType.BOOKING);

    if (!isValidObjectId(propertyId)) {
      return res.status(400).json({
        status: 400,
        message: "Invalid propertyId",
      });
    }

    if (!platform) {
      return res.status(400).json({
        status: 400,
        message: `Invalid platform. Must be one of: ${Object.values(PlatformsType).join(", ")}`,
      });
    }

    if (!validateCookies(cookies)) {
      return res.status(400).json({
        status: 400,
        message:
          "cookies must be a non-empty array where each item has name and value strings",
      });
    }

    const property = await Property.findById(propertyId).select("_id property_name").lean();
    if (!property) {
      return res.status(404).json({
        status: 404,
        message: `Property with ID ${propertyId} not found`,
      });
    }

    const saved = await cookieStorageService.saveCookies(
      propertyId,
      platform,
      cookies
    );

    if (!saved) {
      return res.status(500).json({
        status: 500,
        message: "Failed to save cookies",
      });
    }

    return res.status(200).json({
      status: 200,
      message: "Cookies saved successfully",
      data: {
        id: saved._id,
        propertyId,
        propertyName: property.property_name,
        platform,
        cookieCount: cookies.length,
        expiresAt: saved.expires_at,
        lastUsed: saved.last_used,
        isActive: saved.is_active,
      },
    });
  } catch (err: any) {
    console.error("Error saving cookies:", err);
    return res.status(500).json({
      status: 500,
      message: "Error saving cookies",
      error: err.message,
    });
  }
}) as any);

export default router;
