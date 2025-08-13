import { Router, Request, Response } from "express";
import { bookingCookieManagerDB } from "../services/booking-cookie-manager-db.service.js";
import { bookingSessionPing } from "../services/booking-session-ping.service.js";
import { Property } from "../models/property.model.js";
import { BookingSession } from "../models/booking-session.model.js";

const router = Router();

/**
 * GET /api/booking/sessions/stats
 * Get overall session statistics
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const stats = await bookingCookieManagerDB.getStatistics();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get session statistics",
    });
  }
});

/**
 * GET /api/booking/sessions/trusted
 * Get all trusted sessions
 */
router.get("/trusted", async (req: Request, res: Response) => {
  try {
    const minScore = parseInt(req.query.minScore as string) || 70;
    const sessions = await bookingCookieManagerDB.getTrustedSessions(minScore);
    
    res.json({
      success: true,
      data: {
        count: sessions.length,
        sessions: sessions.map(s => ({
          propertyId: s.property_id,
          bookingId: s.booking_id,
          trustScore: s.trust_score,
          lastPing: s.last_ping_date,
          sessionValid: s.session_valid,
          expiresAt: s.session_expires_date,
          consecutiveSuccesses: s.consecutive_successful_pings,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get trusted sessions",
    });
  }
});

/**
 * GET /api/booking/sessions/property/:propertyId
 * Get session info for a specific property
 */
router.get("/property/:propertyId", async (req: Request, res: Response) => {
  try {
    const { propertyId } = req.params;
    const session = await bookingCookieManagerDB.getSessionInfo(propertyId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: "No session found for this property",
      });
    }
    
    res.json({
      success: true,
      data: {
        propertyId: session.property_id,
        bookingId: session.booking_id,
        sessionValid: session.session_valid,
        trustScore: session.trust_score,
        lastPing: session.last_ping_date,
        lastFullLogin: session.last_full_login_date,
        expiresAt: session.session_expires_date,
        consecutiveSuccesses: session.consecutive_successful_pings,
        consecutiveFailures: session.consecutive_failed_pings,
        totalSuccesses: session.total_successful_pings,
        totalFailures: session.total_failed_pings,
        avgResponseTime: session.avg_ping_response_time,
        requiresCaptcha: session.requires_captcha,
        requires2fa: session.requires_2fa,
        accountLocked: session.account_locked,
        lastError: session.last_error,
        cookieCount: session.cookies.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get session info",
    });
  }
});

/**
 * POST /api/booking/sessions/ping/:propertyId
 * Perform a session ping for a specific property
 */
router.post("/ping/:propertyId", async (req: Request, res: Response) => {
  try {
    const { propertyId } = req.params;
    
    const property = await Property.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        error: "Property not found",
      });
    }
    
    const result = await bookingSessionPing.pingSession(property);
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to ping session",
    });
  }
});

/**
 * POST /api/booking/sessions/ping/batch
 * Perform session pings for multiple properties
 */
router.post("/ping/batch", async (req: Request, res: Response) => {
  try {
    const { propertyIds } = req.body;
    
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "propertyIds must be a non-empty array",
      });
    }
    
    const properties = await Property.find({ _id: { $in: propertyIds } });
    const results = await bookingSessionPing.batchPingSessions(properties);
    
    res.json({
      success: true,
      data: {
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to batch ping sessions",
    });
  }
});

/**
 * DELETE /api/booking/sessions/property/:propertyId
 * Invalidate session for a property
 */
router.delete("/property/:propertyId", async (req: Request, res: Response) => {
  try {
    const { propertyId } = req.params;
    await bookingCookieManagerDB.invalidateSession(propertyId);
    
    res.json({
      success: true,
      message: `Session invalidated for property ${propertyId}`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to invalidate session",
    });
  }
});

/**
 * POST /api/booking/sessions/cleanup
 * Clean up expired sessions
 */
router.post("/cleanup", async (req: Request, res: Response) => {
  try {
    const deletedCount = await bookingCookieManagerDB.cleanupExpiredSessions();
    
    res.json({
      success: true,
      data: {
        deletedCount,
        message: `Cleaned up ${deletedCount} expired sessions`,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to cleanup sessions",
    });
  }
});

/**
 * GET /api/booking/sessions/needing-ping
 * Get sessions that need a ping
 */
router.get("/needing-ping", async (req: Request, res: Response) => {
  try {
    const hoursThreshold = parseInt(req.query.hoursThreshold as string) || 6;
    const sessions = await bookingCookieManagerDB.getSessionsNeedingPing(hoursThreshold);
    
    res.json({
      success: true,
      data: {
        count: sessions.length,
        hoursThreshold,
        sessions: sessions.map(s => ({
          propertyId: s.property_id,
          bookingId: s.booking_id,
          trustScore: s.trust_score,
          lastPing: s.last_ping_date,
          hoursSinceLastPing: s.last_ping_date 
            ? (Date.now() - new Date(s.last_ping_date).getTime()) / (1000 * 60 * 60)
            : null,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get sessions needing ping",
    });
  }
});

/**
 * GET /api/booking/sessions/weekly-maintenance
 * Get properties eligible for weekly maintenance (trusted with high scores)
 */
router.get("/weekly-maintenance", async (req: Request, res: Response) => {
  try {
    const minTrustScore = parseInt(req.query.minScore as string) || 80;
    const sessions = await BookingSession.find({
      session_valid: true,
      trust_score: { $gte: minTrustScore },
      session_expires_date: { $gt: new Date() },
    }).populate("property_id", "property_name booking_id");
    
    res.json({
      success: true,
      data: {
        count: sessions.length,
        minTrustScore,
        eligibleProperties: sessions.map(s => ({
          propertyId: s.property_id,
          bookingId: s.booking_id,
          trustScore: s.trust_score,
          lastPing: s.last_ping_date,
          daysSinceEstablished: s.session_created_date
            ? (Date.now() - new Date(s.session_created_date).getTime()) / (1000 * 60 * 60 * 24)
            : 0,
          consecutiveSuccesses: s.consecutive_successful_pings,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get weekly maintenance properties",
    });
  }
});

export default router;