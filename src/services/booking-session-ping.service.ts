import { Page } from "puppeteer";
import { Property, IProperty, BookingTrustedStatus } from "../models/property.model.js";
import { BookingScraper } from "../scrapers/booking-scraper.js";
import { bookingCookieManagerDB } from "./booking-cookie-manager-db.service.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";
import { BOOKING_SELECTORS } from "../common/booking-selectors.js";

interface SessionPingResult {
  propertyId: string;
  bookingId: string;
  success: boolean;
  sessionValid: boolean;
  trustScore: number;
  error?: string;
}

export class BookingSessionPingService {
  /**
   * Perform a lightweight session ping to maintain trust
   * This is much faster than a full login and preserves the session
   */
  async pingSession(property: IProperty): Promise<SessionPingResult> {
    const propertyId = property._id.toString();
    const bookingId = property.booking_id;
    
    await dualLogInfo(`Starting session ping for property ${propertyId}`, {
      propertyId,
      bookingId,
      propertyName: property.property_name,
    });
    
    const bookingScraper = new BookingScraper();
    
    const startTime = Date.now();
    
    try {
      // Check if we have stored cookies
      const cookies = await bookingCookieManagerDB.getCookies(propertyId);
      
      if (!cookies || cookies.length === 0) {
        await dualLogInfo(`No stored cookies for property ${propertyId}, need full login`);
        return {
          propertyId,
          bookingId,
          success: false,
          sessionValid: false,
          trustScore: property.booking_trust_score || 0,
          error: "No stored cookies available",
        };
      }
      
      // Initialize browser and set cookies
      await bookingScraper.initBrowser();
      const page = await bookingScraper.getPage();
      
      if (!page) {
        throw new Error("Failed to get page from scraper");
      }
      
      // Set stored cookies
      await page.setCookie(...cookies);
      
      // Navigate to a lightweight page to verify session
      await page.goto("https://admin.booking.com/hotel/hoteladmin/general/index.html", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      
      // Check if we're still logged in
      const isLoggedIn = await this.verifyLoggedInState(page);
      
      if (isLoggedIn) {
        // Session is valid, perform a quick ping
        await this.performQuickPing(page, bookingId);
        
        // Get updated cookies
        const updatedCookies = await page.cookies();
        
        // Calculate new trust score
        const currentScore = property.booking_trust_score || 0;
        const successfulLogins = (property.booking_successful_logins || 0) + 1;
        const newTrustScore = Math.min(100, currentScore + 5);
        
        // Save updated cookies with response time
        const responseTime = Date.now() - startTime;
        await bookingCookieManagerDB.saveCookies(
          propertyId,
          bookingId,
          updatedCookies,
          {
            isFullLogin: false,
            responseTime,
            userAgent: await page.evaluate(() => navigator.userAgent),
          }
        );
        
        // Update property trust metrics
        await this.updatePropertyTrustMetrics(
          propertyId,
          newTrustScore,
          successfulLogins,
          0
        );
        
        await dualLogInfo(`Session ping successful for property ${propertyId}`, {
          propertyId,
          bookingId,
          trustScore: newTrustScore,
          successfulLogins,
        });
        
        await bookingScraper.closeBrowser();
        
        return {
          propertyId,
          bookingId,
          success: true,
          sessionValid: true,
          trustScore: newTrustScore,
        };
      } else {
        // Session expired, need full login
        await dualLogInfo(`Session expired for property ${propertyId}, need full login`);
        
        // Mark session as invalid
        await bookingCookieManagerDB.invalidateSession(propertyId);
        
        await bookingScraper.closeBrowser();
        
        return {
          propertyId,
          bookingId,
          success: false,
          sessionValid: false,
          trustScore: property.booking_trust_score || 0,
          error: "Session expired",
        };
      }
    } catch (error) {
      await dualLogError(`Session ping failed for property ${propertyId}`, error);
      
      // Mark session as failed
      await bookingCookieManagerDB.markSessionFailed(
        propertyId,
        error instanceof Error ? error.message : String(error),
        {
          requiresCaptcha: error instanceof Error && error.message.includes('captcha'),
          requires2fa: error instanceof Error && error.message.includes('2fa'),
        }
      );
      
      // Increment failed login count
      const failedLogins = (property.booking_failed_logins || 0) + 1;
      await this.updatePropertyTrustMetrics(
        propertyId,
        Math.max(0, (property.booking_trust_score || 0) - 10),
        property.booking_successful_logins || 0,
        failedLogins
      );
      
      await bookingScraper.closeBrowser();
      
      return {
        propertyId,
        bookingId,
        success: false,
        sessionValid: false,
        trustScore: property.booking_trust_score || 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Verify if we're still logged in
   */
  private async verifyLoggedInState(page: Page): Promise<boolean> {
    try {
      // Check for login form - if present, we're not logged in
      const loginForm = await page.$('form[action*="login"], form[action*="signin"]');
      if (loginForm) {
        return false;
      }
      
      // Check for user menu or property selector - signs we're logged in
      const userMenu = await page.$('.user-menu, .property-selector, [data-testid="header-profile"]');
      if (userMenu) {
        return true;
      }
      
      // Check URL - if redirected to login page
      const currentUrl = page.url();
      if (currentUrl.includes("signin") || currentUrl.includes("login")) {
        return false;
      }
      
      // Check for property ID in the page
      const hasPropertyContext = await page.evaluate(() => {
        return document.body.textContent?.includes("Property ID") || 
               document.body.textContent?.includes("Hotel ID") ||
               document.querySelector('[data-hotel-id]') !== null;
      });
      
      return hasPropertyContext;
    } catch (error) {
      await dualLogError("Error verifying logged in state", error);
      return false;
    }
  }
  
  /**
   * Perform a quick ping to keep session active
   */
  private async performQuickPing(page: Page, bookingId: string): Promise<void> {
    try {
      // Navigate to a lightweight endpoint that refreshes the session
      const pingUrl = `https://admin.booking.com/hotel/hoteladmin/general/index.html?hotel_id=${bookingId}&ses=ping`;
      
      await page.goto(pingUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      
      // Small delay to ensure session is refreshed
      await page.waitForTimeout(2000);
      
      await dualLogInfo(`Session ping completed for booking ID ${bookingId}`);
    } catch (error) {
      await dualLogError(`Error during session ping for booking ID ${bookingId}`, error);
    }
  }
  
  /**
   * Update property trust metrics in database
   */
  private async updatePropertyTrustMetrics(
    propertyId: string,
    trustScore: number,
    successfulLogins: number,
    failedLogins: number
  ): Promise<void> {
    try {
      const updateData: any = {
        booking_trust_score: trustScore,
        booking_successful_logins: successfulLogins,
        booking_failed_logins: failedLogins,
        booking_last_login: new Date(),
      };
      
      // Mark as trusted if score is high enough (>= 70)
      if (trustScore >= 70) {
        updateData.booking_trusted_status = BookingTrustedStatus.Trusted;
        
        // Set trust established date if not already set
        const property = await Property.findById(propertyId);
        if (property && !property.booking_trust_established_date) {
          updateData.booking_trust_established_date = new Date();
        }
      } else if (trustScore < 50) {
        updateData.booking_trusted_status = BookingTrustedStatus.NotTrusted;
      }
      
      await Property.findByIdAndUpdate(propertyId, updateData);
      
      await dualLogInfo(`Updated trust metrics for property ${propertyId}`, {
        propertyId,
        trustScore,
        successfulLogins,
        failedLogins,
      });
    } catch (error) {
      await dualLogError(`Error updating trust metrics for property ${propertyId}`, error);
    }
  }
  
  /**
   * Batch ping sessions for multiple properties
   */
  async batchPingSessions(properties: IProperty[]): Promise<SessionPingResult[]> {
    const results: SessionPingResult[] = [];
    
    for (const property of properties) {
      // Check if property has valid session stored
      const sessionInfo = await bookingCookieManagerDB.getSessionInfo(property._id.toString());
      
      if (sessionInfo && sessionInfo.session_valid && !sessionInfo.isExpired()) {
        const result = await this.pingSession(property);
        results.push(result);
        
        // Small delay between pings
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        results.push({
          propertyId: property._id.toString(),
          bookingId: property.booking_id,
          success: false,
          sessionValid: false,
          trustScore: property.booking_trust_score || 0,
          error: "No valid cookies stored",
        });
      }
    }
    
    return results;
  }
}

// Export singleton instance
export const bookingSessionPing = new BookingSessionPingService();