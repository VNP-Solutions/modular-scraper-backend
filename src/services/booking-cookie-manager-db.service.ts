import { Types } from "mongoose";
import { Cookie } from "puppeteer";
import { BookingSession, IBookingSession, ICookie } from "../models/booking-session.model.js";
import { Property, IProperty } from "../models/property.model.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";

export class BookingCookieManagerDB {
  private sessionCache: Map<string, IBookingSession> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
  private cacheTimestamps: Map<string, number> = new Map();
  
  /**
   * Convert Puppeteer cookies to our ICookie format
   */
  private convertToCookieFormat(cookies: Cookie[]): ICookie[] {
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      size: cookie.size,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite as "Strict" | "Lax" | "None" | undefined,
    }));
  }
  
  /**
   * Convert our ICookie format back to Puppeteer cookies
   */
  private convertToPuppeteerFormat(cookies: ICookie[]): Cookie[] {
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      size: cookie.size,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  }
  
  /**
   * Save or update cookies for a property after successful login
   */
  async saveCookies(
    propertyId: string,
    bookingId: string,
    cookies: Cookie[],
    options: {
      isFullLogin?: boolean;
      responseTime?: number;
      userAgent?: string;
    } = {}
  ): Promise<IBookingSession> {
    try {
      // Check if session already exists
      let session = await BookingSession.findOne({ property_id: propertyId });
      
      const now = new Date();
      const expiresDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
      
      if (session) {
        // Update existing session
        session.cookies = this.convertToCookieFormat(cookies);
        session.session_valid = true;
        session.session_expires_date = expiresDate;
        session.last_ping_date = now;
        
        if (options.isFullLogin) {
          session.last_full_login_date = now;
        }
        
        if (options.userAgent) {
          session.user_agent = options.userAgent;
        }
        
        // Update ping metrics
        session.consecutive_successful_pings++;
        session.consecutive_failed_pings = 0;
        session.total_successful_pings++;
        
        if (options.responseTime) {
          session.last_ping_response_time = options.responseTime;
          
          // Update average response time
          if (session.avg_ping_response_time) {
            session.avg_ping_response_time = 
              (session.avg_ping_response_time * (session.total_successful_pings - 1) + options.responseTime) / 
              session.total_successful_pings;
          } else {
            session.avg_ping_response_time = options.responseTime;
          }
        }
        
        // Clear any error states
        session.requires_captcha = false;
        session.account_locked = false;
        session.last_error = undefined;
        
        await session.save();
      } else {
        // Create new session
        session = await BookingSession.create({
          property_id: new Types.ObjectId(propertyId),
          booking_id: bookingId,
          cookies: this.convertToCookieFormat(cookies),
          user_agent: options.userAgent,
          session_valid: true,
          last_ping_date: now,
          last_full_login_date: options.isFullLogin ? now : undefined,
          session_created_date: now,
          session_expires_date: expiresDate,
          consecutive_successful_pings: 1,
          total_successful_pings: 1,
          last_ping_response_time: options.responseTime,
          avg_ping_response_time: options.responseTime,
        });
      }
      
      // Update cache
      this.sessionCache.set(propertyId, session);
      this.cacheTimestamps.set(propertyId, Date.now());
      
      await dualLogInfo(`Saved cookies for property ${propertyId}`, {
        propertyId,
        bookingId,
        cookieCount: cookies.length,
        trustScore: session.trust_score,
        expiresAt: session.session_expires_date,
        isFullLogin: options.isFullLogin,
      });
      
      return session;
    } catch (error) {
      await dualLogError(`Failed to save cookies for property ${propertyId}`, error);
      throw error;
    }
  }
  
  /**
   * Get stored cookies for a property
   */
  async getCookies(propertyId: string): Promise<Cookie[] | null> {
    try {
      // Check cache first
      const cached = this.getCachedSession(propertyId);
      if (cached && cached.session_valid && !cached.isExpired()) {
        return this.convertToPuppeteerFormat(cached.cookies);
      }
      
      // Fetch from database
      const session = await BookingSession.findValidSession(propertyId);
      
      if (!session) {
        return null;
      }
      
      // Update cache
      this.sessionCache.set(propertyId, session);
      this.cacheTimestamps.set(propertyId, Date.now());
      
      await dualLogInfo(`Retrieved cookies for property ${propertyId}`, {
        propertyId,
        cookieCount: session.cookies.length,
        trustScore: session.trust_score,
        lastPing: session.last_ping_date,
      });
      
      return this.convertToPuppeteerFormat(session.cookies);
    } catch (error) {
      await dualLogError(`Failed to get cookies for property ${propertyId}`, error);
      return null;
    }
  }
  
  /**
   * Mark session as failed
   */
  async markSessionFailed(
    propertyId: string,
    error: string,
    options: {
      requiresCaptcha?: boolean;
      requires2fa?: boolean;
      accountLocked?: boolean;
    } = {}
  ): Promise<void> {
    try {
      const session = await BookingSession.findOne({ property_id: propertyId });
      
      if (session) {
        session.consecutive_failed_pings++;
        session.consecutive_successful_pings = 0;
        session.total_failed_pings++;
        session.last_error = error;
        
        if (options.requiresCaptcha) {
          session.requires_captcha = true;
        }
        if (options.requires2fa) {
          session.requires_2fa = true;
        }
        if (options.accountLocked) {
          session.account_locked = true;
          session.session_valid = false;
        }
        
        // Invalidate session if too many failures
        if (session.consecutive_failed_pings >= 3) {
          session.session_valid = false;
        }
        
        await session.save();
        
        // Clear from cache
        this.sessionCache.delete(propertyId);
        this.cacheTimestamps.delete(propertyId);
        
        await dualLogInfo(`Marked session as failed for property ${propertyId}`, {
          propertyId,
          consecutiveFailures: session.consecutive_failed_pings,
          sessionValid: session.session_valid,
          error,
        });
      }
    } catch (error) {
      await dualLogError(`Failed to mark session as failed for property ${propertyId}`, error);
    }
  }
  
  /**
   * Invalidate session for a property
   */
  async invalidateSession(propertyId: string): Promise<void> {
    try {
      await BookingSession.updateOne(
        { property_id: propertyId },
        { 
          session_valid: false,
          cookies: [],
          last_error: "Session invalidated",
        }
      );
      
      // Clear from cache
      this.sessionCache.delete(propertyId);
      this.cacheTimestamps.delete(propertyId);
      
      await dualLogInfo(`Invalidated session for property ${propertyId}`);
    } catch (error) {
      await dualLogError(`Failed to invalidate session for property ${propertyId}`, error);
    }
  }
  
  /**
   * Get session info for a property
   */
  async getSessionInfo(propertyId: string): Promise<IBookingSession | null> {
    try {
      // Check cache first
      const cached = this.getCachedSession(propertyId);
      if (cached) {
        return cached;
      }
      
      // Fetch from database
      const session = await BookingSession.findOne({ property_id: propertyId });
      
      if (session) {
        // Update cache
        this.sessionCache.set(propertyId, session);
        this.cacheTimestamps.set(propertyId, Date.now());
      }
      
      return session;
    } catch (error) {
      await dualLogError(`Failed to get session info for property ${propertyId}`, error);
      return null;
    }
  }
  
  /**
   * Get all trusted sessions
   */
  async getTrustedSessions(minTrustScore: number = 70): Promise<IBookingSession[]> {
    try {
      return await BookingSession.findTrustedSessions(minTrustScore);
    } catch (error) {
      await dualLogError("Failed to get trusted sessions", error);
      return [];
    }
  }
  
  /**
   * Get sessions needing ping
   */
  async getSessionsNeedingPing(hoursThreshold: number = 6): Promise<IBookingSession[]> {
    try {
      return await BookingSession.findSessionsNeedingPing(hoursThreshold);
    } catch (error) {
      await dualLogError("Failed to get sessions needing ping", error);
      return [];
    }
  }
  
  /**
   * Update session metadata
   */
  async updateSessionMetadata(propertyId: string, metadata: Record<string, any>): Promise<void> {
    try {
      await BookingSession.updateOne(
        { property_id: propertyId },
        { $set: { metadata } }
      );
      
      // Clear from cache to force refresh
      this.sessionCache.delete(propertyId);
      this.cacheTimestamps.delete(propertyId);
    } catch (error) {
      await dualLogError(`Failed to update session metadata for property ${propertyId}`, error);
    }
  }
  
  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    try {
      const deletedCount = await BookingSession.cleanupExpiredSessions();
      
      if (deletedCount > 0) {
        await dualLogInfo(`Cleaned up ${deletedCount} expired sessions`);
        
        // Clear cache entries for expired sessions
        for (const [propertyId, session] of this.sessionCache.entries()) {
          if (session.isExpired()) {
            this.sessionCache.delete(propertyId);
            this.cacheTimestamps.delete(propertyId);
          }
        }
      }
      
      return deletedCount;
    } catch (error) {
      await dualLogError("Failed to cleanup expired sessions", error);
      return 0;
    }
  }
  
  /**
   * Get cached session if valid
   */
  private getCachedSession(propertyId: string): IBookingSession | null {
    const cached = this.sessionCache.get(propertyId);
    const timestamp = this.cacheTimestamps.get(propertyId);
    
    if (cached && timestamp && (Date.now() - timestamp) < this.CACHE_TTL) {
      return cached;
    }
    
    return null;
  }
  
  /**
   * Clear cache
   */
  clearCache(): void {
    this.sessionCache.clear();
    this.cacheTimestamps.clear();
  }
  
  /**
   * Get statistics about stored sessions
   */
  async getStatistics(): Promise<{
    totalSessions: number;
    validSessions: number;
    trustedSessions: number;
    expiredSessions: number;
    averageTrustScore: number;
  }> {
    try {
      const now = new Date();
      
      const [total, valid, trusted, expired] = await Promise.all([
        BookingSession.countDocuments(),
        BookingSession.countDocuments({ session_valid: true, session_expires_date: { $gt: now } }),
        BookingSession.countDocuments({ session_valid: true, trust_score: { $gte: 70 }, session_expires_date: { $gt: now } }),
        BookingSession.countDocuments({ session_expires_date: { $lte: now } }),
      ]);
      
      const avgTrustScore = await BookingSession.aggregate([
        { $match: { session_valid: true } },
        { $group: { _id: null, avgScore: { $avg: "$trust_score" } } },
      ]);
      
      return {
        totalSessions: total,
        validSessions: valid,
        trustedSessions: trusted,
        expiredSessions: expired,
        averageTrustScore: avgTrustScore[0]?.avgScore || 0,
      };
    } catch (error) {
      await dualLogError("Failed to get session statistics", error);
      return {
        totalSessions: 0,
        validSessions: 0,
        trustedSessions: 0,
        expiredSessions: 0,
        averageTrustScore: 0,
      };
    }
  }
}

// Export singleton instance
export const bookingCookieManagerDB = new BookingCookieManagerDB();