import * as cron from "node-cron";
import { Property, IProperty, BookingTrustedStatus } from "../models/property.model.js";
import { BookingSession } from "../models/booking-session.model.js";
import { bookingSessionPing } from "./booking-session-ping.service.js";
import { bookingCookieManagerDB } from "./booking-cookie-manager-db.service.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";

interface MaintenanceStats {
  totalSessionsChecked: number;
  successfulPings: number;
  failedPings: number;
  sessionsRequiringFullLogin: number;
  highTrustProperties: number;
  mediumTrustProperties: number;
  lowTrustProperties: number;
  totalRuntime: number;
}

export class BookingSessionMaintenanceService {
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private lastRun?: Date;
  private stats: MaintenanceStats = {
    totalSessionsChecked: 0,
    successfulPings: 0,
    failedPings: 0,
    sessionsRequiringFullLogin: 0,
    highTrustProperties: 0,
    mediumTrustProperties: 0,
    lowTrustProperties: 0,
    totalRuntime: 0,
  };
  
  /**
   * Get properties that need session maintenance based on trust levels:
   * - High trust (score >= 80): Check every 7 days (weekly maintenance)
   * - Medium trust (score 50-79): Check every 2 days
   * - Low trust (score < 50): Check every 12 hours
   */
  async getPropertiesForMaintenance(): Promise<IProperty[]> {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    
    try {
      // Get all active properties with booking credentials
      const properties = await Property.find({
        booking_id: { $exists: true, $ne: null, $nin: ["0", ""] },
        user_email: { $exists: true, $ne: null },
        user_password: { $exists: true, $ne: null },
        status: "active",
      });
      
      const propertiesForMaintenance: IProperty[] = [];
      
      for (const property of properties) {
        // Get session info for this property
        const session = await BookingSession.findOne({ property_id: property._id });
        
        if (!session || !session.session_valid) {
          // No valid session, needs full login (handled by trust scheduler)
          continue;
        }
        
        const trustScore = session.trust_score || 0;
        const lastPing = session.last_ping_date || new Date(0);
        
        // Determine if maintenance is needed based on trust level
        if (trustScore >= 80) {
          // High trust: Weekly maintenance
          if (lastPing <= sevenDaysAgo) {
            propertiesForMaintenance.push(property);
            this.stats.highTrustProperties++;
          }
        } else if (trustScore >= 50) {
          // Medium trust: Every 2 days
          if (lastPing <= twoDaysAgo) {
            propertiesForMaintenance.push(property);
            this.stats.mediumTrustProperties++;
          }
        } else {
          // Low trust: Every 12 hours
          if (lastPing <= twelveHoursAgo) {
            propertiesForMaintenance.push(property);
            this.stats.lowTrustProperties++;
          }
        }
      }
      
      await dualLogInfo(`Found ${propertiesForMaintenance.length} properties for session maintenance`, {
        total: propertiesForMaintenance.length,
        highTrust: this.stats.highTrustProperties,
        mediumTrust: this.stats.mediumTrustProperties,
        lowTrust: this.stats.lowTrustProperties,
      });
      
      return propertiesForMaintenance;
    } catch (error) {
      await dualLogError("Error getting properties for maintenance", error);
      return [];
    }
  }
  
  /**
   * Run session maintenance
   */
  async runMaintenance(): Promise<MaintenanceStats> {
    if (this.isRunning) {
      await dualLogInfo("Session maintenance already running, skipping this run");
      return this.stats;
    }
    
    const startTime = Date.now();
    this.isRunning = true;
    this.lastRun = new Date();
    
    await dualLogInfo("Starting booking session maintenance");
    
    try {
      // Reset stats for this run
      this.stats = {
        totalSessionsChecked: 0,
        successfulPings: 0,
        failedPings: 0,
        sessionsRequiringFullLogin: 0,
        highTrustProperties: 0,
        mediumTrustProperties: 0,
        lowTrustProperties: 0,
        totalRuntime: 0,
      };
      
      // Clean up expired sessions first
      const cleanedCount = await bookingCookieManagerDB.cleanupExpiredSessions();
      if (cleanedCount > 0) {
        await dualLogInfo(`Cleaned up ${cleanedCount} expired sessions`);
      }
      
      // Get properties needing maintenance
      const properties = await this.getPropertiesForMaintenance();
      this.stats.totalSessionsChecked = properties.length;
      
      if (properties.length === 0) {
        await dualLogInfo("No properties need session maintenance at this time");
        return this.stats;
      }
      
      // Process each property
      for (const property of properties) {
        try {
          const session = await BookingSession.findOne({ property_id: property._id });
          
          if (!session || !session.session_valid) {
            this.stats.sessionsRequiringFullLogin++;
            continue;
          }
          
          // Perform session ping
          const result = await bookingSessionPing.pingSession(property);
          
          if (result.success) {
            this.stats.successfulPings++;
            
            await dualLogInfo(`Session maintenance successful for property ${property._id}`, {
              propertyId: property._id,
              bookingId: property.booking_id,
              trustScore: result.trustScore,
              method: "session_ping",
            });
          } else {
            this.stats.failedPings++;
            
            if (!result.sessionValid) {
              this.stats.sessionsRequiringFullLogin++;
            }
            
            await dualLogInfo(`Session maintenance failed for property ${property._id}`, {
              propertyId: property._id,
              bookingId: property.booking_id,
              error: result.error,
              sessionValid: result.sessionValid,
            });
          }
          
          // Small delay between properties
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          await dualLogError(`Error processing property ${property._id} in maintenance`, error);
          this.stats.failedPings++;
        }
      }
      
      this.stats.totalRuntime = Date.now() - startTime;
      
      await dualLogInfo("Booking session maintenance completed", {
        stats: this.stats,
        duration: `${this.stats.totalRuntime}ms`,
      });
      
      return this.stats;
    } catch (error) {
      await dualLogError("Error in session maintenance", error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }
  
  /**
   * Start the maintenance cron job
   * Runs every 30 minutes to check for properties needing maintenance
   */
  start(): void {
    if (this.cronJob) {
      console.log("Session maintenance cron job is already running");
      return;
    }
    
    // Run every 30 minutes
    this.cronJob = cron.schedule("*/30 * * * *", async () => {
      console.log(`[${new Date().toISOString()}] Running session maintenance...`);
      
      try {
        await this.runMaintenance();
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Session maintenance error:`, error);
      }
    });
    
    console.log("Session maintenance cron job started (runs every 30 minutes)");
  }
  
  /**
   * Stop the maintenance cron job
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log("Session maintenance cron job stopped");
    }
  }
  
  /**
   * Get maintenance status and statistics
   */
  getStatus(): {
    isRunning: boolean;
    lastRun?: Date;
    stats: MaintenanceStats;
    cronActive: boolean;
  } {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      stats: this.stats,
      cronActive: this.cronJob !== null,
    };
  }
  
  /**
   * Manually trigger maintenance
   */
  async triggerMaintenance(): Promise<MaintenanceStats> {
    console.log(`[${new Date().toISOString()}] Manual session maintenance triggered`);
    return await this.runMaintenance();
  }
  
  /**
   * Get properties grouped by trust level
   */
  async getPropertiesByTrustLevel(): Promise<{
    highTrust: number;
    mediumTrust: number;
    lowTrust: number;
    noSession: number;
  }> {
    try {
      const properties = await Property.find({
        booking_id: { $exists: true, $ne: null, $nin: ["0", ""] },
        status: "active",
      });
      
      let highTrust = 0;
      let mediumTrust = 0;
      let lowTrust = 0;
      let noSession = 0;
      
      for (const property of properties) {
        const session = await BookingSession.findOne({ property_id: property._id });
        
        if (!session || !session.session_valid) {
          noSession++;
        } else {
          const trustScore = session.trust_score || 0;
          
          if (trustScore >= 80) {
            highTrust++;
          } else if (trustScore >= 50) {
            mediumTrust++;
          } else {
            lowTrust++;
          }
        }
      }
      
      return {
        highTrust,
        mediumTrust,
        lowTrust,
        noSession,
      };
    } catch (error) {
      await dualLogError("Error getting properties by trust level", error);
      return {
        highTrust: 0,
        mediumTrust: 0,
        lowTrust: 0,
        noSession: 0,
      };
    }
  }
}

// Export singleton instance
export const bookingSessionMaintenance = new BookingSessionMaintenanceService();