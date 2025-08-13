import { Property, IProperty } from "../models/property.model.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";
import * as fs from "fs/promises";
import * as path from "path";
import { Cookie } from "puppeteer";

interface StoredSession {
  propertyId: string;
  bookingId: string;
  cookies: Cookie[];
  lastUpdated: Date;
  trustScore: number;
  expiresAt: Date;
}

export class BookingCookieManager {
  private cookieStorePath: string;
  private sessions: Map<string, StoredSession> = new Map();
  
  constructor() {
    this.cookieStorePath = path.join(process.cwd(), "data", "booking-sessions");
    this.initializeStorage();
  }
  
  private async initializeStorage() {
    try {
      await fs.mkdir(this.cookieStorePath, { recursive: true });
      await this.loadSessions();
    } catch (error) {
      await dualLogError("Failed to initialize cookie storage", error);
    }
  }
  
  private async loadSessions() {
    try {
      const files = await fs.readdir(this.cookieStorePath);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(this.cookieStorePath, file);
          const content = await fs.readFile(filePath, "utf-8");
          const session: StoredSession = JSON.parse(content);
          
          // Check if session is still valid
          if (new Date(session.expiresAt) > new Date()) {
            this.sessions.set(session.propertyId, session);
          } else {
            // Clean up expired session file
            await fs.unlink(filePath).catch(() => {});
          }
        }
      }
      
      await dualLogInfo(`Loaded ${this.sessions.size} valid cookie sessions`);
    } catch (error) {
      await dualLogError("Failed to load cookie sessions", error);
    }
  }
  
  /**
   * Save cookies for a property after successful login
   */
  async saveCookies(
    propertyId: string,
    bookingId: string,
    cookies: Cookie[],
    trustScore: number = 0
  ): Promise<void> {
    try {
      const session: StoredSession = {
        propertyId,
        bookingId,
        cookies,
        lastUpdated: new Date(),
        trustScore,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      };
      
      this.sessions.set(propertyId, session);
      
      // Persist to disk
      const filePath = path.join(this.cookieStorePath, `${propertyId}.json`);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
      
      await dualLogInfo(`Saved cookies for property ${propertyId}`, {
        propertyId,
        bookingId,
        cookieCount: cookies.length,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      await dualLogError(`Failed to save cookies for property ${propertyId}`, error);
    }
  }
  
  /**
   * Get stored cookies for a property
   */
  async getCookies(propertyId: string): Promise<Cookie[] | null> {
    const session = this.sessions.get(propertyId);
    
    if (!session) {
      return null;
    }
    
    // Check if session is expired
    if (new Date(session.expiresAt) <= new Date()) {
      await this.removeCookies(propertyId);
      return null;
    }
    
    await dualLogInfo(`Retrieved cookies for property ${propertyId}`, {
      propertyId,
      cookieCount: session.cookies.length,
      lastUpdated: session.lastUpdated,
    });
    
    return session.cookies;
  }
  
  /**
   * Remove cookies for a property
   */
  async removeCookies(propertyId: string): Promise<void> {
    try {
      this.sessions.delete(propertyId);
      const filePath = path.join(this.cookieStorePath, `${propertyId}.json`);
      await fs.unlink(filePath).catch(() => {});
      
      await dualLogInfo(`Removed cookies for property ${propertyId}`);
    } catch (error) {
      await dualLogError(`Failed to remove cookies for property ${propertyId}`, error);
    }
  }
  
  /**
   * Check if property has valid stored cookies
   */
  hasValidCookies(propertyId: string): boolean {
    const session = this.sessions.get(propertyId);
    if (!session) return false;
    
    return new Date(session.expiresAt) > new Date();
  }
  
  /**
   * Update trust score for a property session
   */
  async updateTrustScore(propertyId: string, trustScore: number): Promise<void> {
    const session = this.sessions.get(propertyId);
    if (session) {
      session.trustScore = trustScore;
      session.lastUpdated = new Date();
      
      const filePath = path.join(this.cookieStorePath, `${propertyId}.json`);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    }
  }
  
  /**
   * Get all trusted sessions with high trust scores
   */
  getTrustedSessions(minTrustScore: number = 70): StoredSession[] {
    return Array.from(this.sessions.values()).filter(
      session => session.trustScore >= minTrustScore && 
                 new Date(session.expiresAt) > new Date()
    );
  }
  
  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<void> {
    const now = new Date();
    let cleanedCount = 0;
    
    for (const [propertyId, session] of this.sessions.entries()) {
      if (new Date(session.expiresAt) <= now) {
        await this.removeCookies(propertyId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      await dualLogInfo(`Cleaned up ${cleanedCount} expired cookie sessions`);
    }
  }
}

// Export singleton instance
export const bookingCookieManager = new BookingCookieManager();