import { Property, IProperty, BookingTrustedStatus } from "../models/property.model.js";
import { BookingScraper, ScraperContext } from "../scrapers/booking-scraper.js";
import { dualLogInfo, dualLogError } from "../common/log-helper.js";
import { initializeJobLogging, finalizeJobLogging } from "../common/log-helper.js";
import { BOOKING_SELECTORS } from "../common/booking-selectors.js";
import { BookingErrorType, BookingScrapingPhase } from "../common/booking-error-types.js";
import { decryptPassword } from "../common/encription.js";

interface TrustVerificationResult {
  propertyId: string;
  bookingId: string;
  previousStatus: BookingTrustedStatus;
  newStatus: BookingTrustedStatus;
  success: boolean;
  error?: string;
  hasCardDetailsLinks?: boolean;
}

interface TrustSchedulerStats {
  totalPropertiesChecked: number;
  successfulVerifications: number;
  failedVerifications: number;
  newlyTrusted: number;
  remainingUntrusted: number;
  totalRuntime: number;
}

export class BookingTrustSchedulerService {
  private isRunning = false;
  private lastRun?: Date;
  private stats: TrustSchedulerStats = {
    totalPropertiesChecked: 0,
    successfulVerifications: 0,
    failedVerifications: 0,
    newlyTrusted: 0,
    remainingUntrusted: 0,
    totalRuntime: 0,
  };

  /**
   * Get properties that need trust verification based on the rules:
   * a. Properties with last_login >= 23h and trusted_status = not_trusted
   * b. OR Properties with last_login >= 6d and trusted_status = trusted
   */
  async getPropertiesForTrustVerification(): Promise<IProperty[]> {
    const now = new Date();
    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);

    try {
      const properties = await Property.find({
        $and: [
          { booking_id: { $exists: true, $ne: null, $nin: ["0", ""] } }, // Must have valid booking_id
          {
            $or: [
              {
                // Not trusted properties that haven't been checked in 23+ hours
                $and: [
                  { booking_trusted_status: BookingTrustedStatus.NotTrusted },
                  {
                    $or: [
                      { booking_last_login: { $lte: twentyThreeHoursAgo } },
                      { booking_last_login: { $exists: false } }, // Never logged in
                    ],
                  },
                ],
              },
              {
                // Trusted properties that haven't been verified in 6+ days
                $and: [
                  { booking_trusted_status: BookingTrustedStatus.Trusted },
                  {
                    $or: [
                      { booking_last_login: { $lte: sixDaysAgo } },
                      { booking_last_login: { $exists: false } }, // Never logged in
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }).populate({
        path: 'credentials',
        match: {
          bookingUsername: { $exists: true, $ne: null },
          bookingPassword: { $exists: true, $ne: null }
        }
      });

      await dualLogInfo(
        `Found ${properties.length} properties for trust verification`,
        {
          totalProperties: properties.length,
          notTrustedCount: properties.filter(
            (p) => p.booking_trusted_status === BookingTrustedStatus.NotTrusted
          ).length,
          trustedCount: properties.filter(
            (p) => p.booking_trusted_status === BookingTrustedStatus.Trusted
          ).length,
        }
      );

      return properties;
    } catch (error) {
      await dualLogError("Error getting properties for trust verification", error);
      return [];
    }
  }

  /**
   * Verify trust status for a single property
   */
  async verifyPropertyTrust(property: IProperty): Promise<TrustVerificationResult> {
    const propertyId = property._id.toString();
    const bookingId = property.booking_id;
    const previousStatus = property.booking_trusted_status || BookingTrustedStatus.NotTrusted;

    await dualLogInfo(`Starting trust verification for property ${propertyId}`, {
      propertyId,
      bookingId,
      propertyName: property.property_name,
      previousStatus,
    });

    try {
      // Initialize logging for this verification
      initializeJobLogging(`trust-verify-${propertyId}`);

      // Create booking scraper instance
      const bookingScraper = new BookingScraper(ScraperContext.TRUST_VERIFICATION);
      
      const { browser, page } = await bookingScraper.setupBrowser();
      bookingScraper.setBrowserData(page, browser)

      // Attempt booking login
      try {
        const credentials = property.credentials?.[0];
        const password = credentials?.bookingPassword ? decryptPassword(credentials.bookingPassword) : undefined;

        await bookingScraper.login({
            email: credentials?.bookingUsername!,
            password: password!,
          }, 
          property.booking_id
        );

        // Navigate to VCCS management page to verify card details access
        await dualLogInfo(`Navigating to VCCS management for property ${propertyId}`);
        
        let hasCardDetailsLinks = false;
        let newStatus = BookingTrustedStatus.NotTrusted;

        // Update property trust status
        await this.updatePropertyTrustStatus(propertyId, newStatus, new Date());
        
        try {
          await bookingScraper.navigateToMenuSection('finance', 'vccs_management', 'vccs_management');
          
          // Wait for the page to load and check for card details links
          const page = await bookingScraper.getPage();
          if (page) {
            // Wait for the table to load
            await page.waitForSelector(BOOKING_SELECTORS.vccs.table, { timeout: 10000 });
            
            // Check if there are any "View card details" links available and clickable (have href)
            hasCardDetailsLinks = await page.evaluate((selectors) => {
              const cardDetailLinks = document.querySelectorAll(selectors);
              let clickableLinks = 0;
              
              cardDetailLinks.forEach(link => {
                const href = link.getAttribute('href');
                if (href && href.trim() !== '') {
                  clickableLinks++;
                }
              });
              
              return clickableLinks > 0;
            }, BOOKING_SELECTORS.vccs.viewCardDetailsLink);
            
            await dualLogInfo(`Card details verification for property ${propertyId}`, {
              hasCardDetailsLinks,
            });
          }
          
          newStatus = hasCardDetailsLinks ? BookingTrustedStatus.Trusted : BookingTrustedStatus.NotTrusted;

          // Update property trust status
          await this.updatePropertyTrustStatus(propertyId, newStatus, new Date());

          await dualLogInfo(`Trust verification completed for property ${propertyId}`, {
            propertyId,
            bookingId,
            previousStatus,
            newStatus,
            hasCardDetailsLinks,
            statusChanged: previousStatus !== newStatus,
          });
  
          await finalizeJobLogging("success");
  
          return {
            propertyId,
            bookingId,
            previousStatus,
            newStatus,
            success: true,
            hasCardDetailsLinks,
          };

        } catch (navigationError) {
          await dualLogError(
            `Trust verification failed - navigation to VCCS management failed for property ${propertyId}`,
            navigationError,
            { propertyId, bookingId, previousStatus }
          );
          
          await finalizeJobLogging("failed");

          return {
            propertyId,
            bookingId,
            previousStatus,
            newStatus: previousStatus,
            success: false,
            error: navigationError instanceof Error ? navigationError.message : String(navigationError),
          };
        }
      } catch (loginError) {
        await dualLogError(
          `Trust verification failed - login failed for property ${propertyId}`,
          loginError,
          { propertyId, bookingId, previousStatus }
        );

        await finalizeJobLogging("failed");

        return {
          propertyId,
          bookingId,
          previousStatus,
          newStatus: previousStatus,
          success: false,
          error: loginError instanceof Error ? loginError.message : String(loginError),
        };
      }
    } catch (error) {
      await dualLogError(
        `Trust verification error for property ${propertyId}`,
        error,
        { propertyId, bookingId, previousStatus }
      );

      await finalizeJobLogging("failed");

      return {
        propertyId,
        bookingId,
        previousStatus,
        newStatus: previousStatus,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Update property trust status and last login time
   */
  private async updatePropertyTrustStatus(
    propertyId: string,
    trustedStatus: BookingTrustedStatus,
    lastLogin: Date
  ): Promise<void> {
    try {
      await Property.findByIdAndUpdate(propertyId, {
        booking_trusted_status: trustedStatus,
        booking_last_login: lastLogin,
      });

      await dualLogInfo(`Updated property ${propertyId} trust status`, {
        propertyId,
        trustedStatus,
        lastLogin: lastLogin.toISOString(),
      });
    } catch (error) {
      await dualLogError(
        `Error updating property ${propertyId} trust status`,
        error,
        { propertyId, trustedStatus }
      );
    }
  }

  /**
   * Run the trust verification scheduler
   */
  async runTrustScheduler(): Promise<TrustSchedulerStats> {
    if (this.isRunning) {
      await dualLogInfo("Trust scheduler already running, skipping this run");
      return this.stats;
    }

    const startTime = Date.now();
    this.isRunning = true;
    this.lastRun = new Date();

    await dualLogInfo("Starting booking trust verification scheduler");

    try {
      // Reset stats for this run
      this.stats = {
        totalPropertiesChecked: 0,
        successfulVerifications: 0,
        failedVerifications: 0,
        newlyTrusted: 0,
        remainingUntrusted: 0,
        totalRuntime: 0,
      };

      // Get properties that need verification
      const properties = await this.getPropertiesForTrustVerification();
      this.stats.totalPropertiesChecked = properties.length;

      if (properties.length === 0) {
        await dualLogInfo("No properties need trust verification at this time");
        return this.stats;
      }

      // Process each property
      for (const property of properties) {
        try {
          const result = await this.verifyPropertyTrust(property);

          if (result.success) {
            this.stats.successfulVerifications++;
            if (
              result.previousStatus === BookingTrustedStatus.NotTrusted &&
              result.newStatus === BookingTrustedStatus.Trusted
            ) {
              this.stats.newlyTrusted++;
            }
          } else {
            this.stats.failedVerifications++;
          }

          if (result.newStatus === BookingTrustedStatus.NotTrusted) {
            this.stats.remainingUntrusted++;
          }

          // Add small delay between properties to avoid overwhelming the system
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          await dualLogError(
            `[${new Date().toISOString()}] Error processing property ${property._id} in trust scheduler`,
            {
              errorType: BookingErrorType.UNKNOWN,
              error: error,
              phase: BookingScrapingPhase.BUILDING_TRUST,
              platform: 'booking',
              action: 'run_trust_scheduler'
            }
          );
          this.stats.failedVerifications++;
        }
      }

      this.stats.totalRuntime = Date.now() - startTime;

      await dualLogInfo("Booking trust verification scheduler completed", {
        stats: this.stats,
        duration: `${this.stats.totalRuntime}ms`,
      });

      return this.stats;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] Error in trust verification scheduler`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.BUILDING_TRUST,
          platform: 'booking',
          action: 'run_trust_scheduler'
        }
      );
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get scheduler status and statistics
   */
  getSchedulerStatus(): {
    isRunning: boolean;
    lastRun?: Date;
    stats: TrustSchedulerStats;
  } {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      stats: this.stats,
    };
  }

  /**
   * Manually trigger trust verification for a specific property
   */
  async verifySpecificProperty(propertyId: string): Promise<TrustVerificationResult> {
    const property = await Property.findById(propertyId);
    if (!property) {
      throw new Error(`Property ${propertyId} not found`);
    }

    if (!property.booking_id || property.booking_id === "0") {
      throw new Error(`Property ${propertyId} has no valid booking_id`);
    }

    if (!property.user_email || !property.user_password) {
      throw new Error(`Property ${propertyId} has no booking credentials`);
    }

    return await this.verifyPropertyTrust(property);
  }
}

// Export singleton instance
export const bookingTrustScheduler = new BookingTrustSchedulerService();