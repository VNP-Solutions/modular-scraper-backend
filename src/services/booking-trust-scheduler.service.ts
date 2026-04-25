import {
  BookingErrorType,
  BookingScrapingPhase,
} from "../common/booking-error-types.js";
import { BOOKING_SELECTORS } from "../common/booking-selectors.js";
import { decryptPassword } from "../common/encription.js";
import { setJobContact } from "../common/job-phone-store.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
  finalizeJobLogging,
  initializeJobLogging,
} from "../common/log-helper.js";
import { otpAwareWorkerPool } from "../common/otp-aware-worker-pool.js";
import { Types } from "mongoose";
import {
  Job,
  JobStatus,
  OTAProvider,
} from "../models/job.model.js";
import { PropertyCredentials } from "../models/Property-credentials.js";
import {
  BookingTrustedStatus,
  IProperty,
  Property,
} from "../models/property.model.js";
import { BookingScraper, ScraperContext } from "../scrapers/booking-scraper.js";
import { notificationService } from "./notification.service.js";
import { phoneNumberSlotService } from "./phone-number-slot.service.js";

interface TrustVerificationResult {
  propertyId: string;
  bookingId: number;
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
   * Get properties that need trust verification.
   *
   * Current rules: only properties that have at least one **Booking** job in
   * `Pending` only, plus valid `booking_id` and booking credentials
   * (same populate match as before).
   *
   * Legacy rules (time-based refresh for all eligible properties) are kept in
   * comments below — do not delete; re-apply by swapping the active
   * `Property.find` filter if needed in the future.
   */
  async getPropertiesForTrustVerification(): Promise<IProperty[]> {
    try {
      const propertyIdsWithPendingBookingJobs = await Job.distinct(
        "property_id",
        {
          $or: [
            { ota_provider: OTAProvider.Booking },
            { OTA: OTAProvider.Booking },
          ],
          job_status: JobStatus.Pending,
          property_id: { $exists: true, $ne: null },
        }
      );

      if (propertyIdsWithPendingBookingJobs.length === 0) {
        await dualLogInfo(
          "No properties with pending Booking jobs — trust verification candidate list empty",
          { distinctPropertiesWithPendingJobs: 0 }
        );
        return [];
      }

      /*
       * --- LEGACY: previous Property.find filter (no job filter) ---
       * Used with time windows twentyThreeHoursAgo / sixDaysAgo on
       * booking_last_login and booking_trusted_status. Restore by replacing
       * the active `Property.find` below with this block (and reintroduce
       * `now`, `twentyThreeHoursAgo`, `sixDaysAgo` above).
       *
       * const now = new Date();
       * const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * 60 * 1000);
       * const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
       *
       * await Property.find({
       *   $and: [
       *     { booking_id: { $exists: true, $nin: ["0", "", null] } },
       *     {
       *       $or: [
       *         {
       *           $and: [
       *             {
       *               $or: [
       *                 { booking_trusted_status: BookingTrustedStatus.NotTrusted },
       *                 { booking_trusted_status: { $exists: false } },
       *               ],
       *             },
       *             {
       *               $or: [
       *                 { booking_last_login: { $lte: twentyThreeHoursAgo } },
       *                 { booking_last_login: { $exists: false } },
       *               ],
       *             },
       *           ],
       *         },
       *         {
       *           $and: [
       *             { booking_trusted_status: BookingTrustedStatus.Trusted },
       *             {
       *               $or: [
       *                 { booking_last_login: { $lte: sixDaysAgo } },
       *                 { booking_last_login: { $exists: false } },
       *               ],
       *             },
       *           ],
       *         },
       *       ],
       *     },
       *   ],
       * })
       */

      const properties = await Property.find({
        $and: [
          { _id: { $in: propertyIdsWithPendingBookingJobs } },
          { booking_id: { $exists: true, $nin: ["0", "", null] } },
        ],
      })
        .populate({
          path: "credentials",
          match: {
            bookingUsername: { $exists: true, $ne: null },
            bookingPassword: { $exists: true, $ne: null },
          },
        })
        .lean();

      await dualLogInfo(
        `Found ${properties.length} properties for trust verification (distinct properties with pending Booking jobs: ${propertyIdsWithPendingBookingJobs.length})`,
        {
          totalProperties: properties.length,
          distinctPropertiesWithPendingJobs:
            propertyIdsWithPendingBookingJobs.length,
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
      await dualLogError(
        "Error getting properties for trust verification",
        error
      );
      return [];
    }
  }

  /**
   * One pending Booking job for this property (same filter as trust candidate list).
   * Used so OTP phone/slot matches scraping (`handleBookingOtpVerification` + job lock).
   */
  private async findOnePendingBookingJobIdForProperty(
    propertyId: string
  ): Promise<string | null> {
    try {
      if (!Types.ObjectId.isValid(propertyId)) {
        return null;
      }
      const doc = await Job.findOne({
        property_id: new Types.ObjectId(propertyId),
        $or: [
          { ota_provider: OTAProvider.Booking },
          { OTA: OTAProvider.Booking },
        ],
        job_status: JobStatus.Pending,
      })
        .sort({ updatedAt: -1 })
        .select("_id")
        .lean();
      return doc?._id ? String(doc._id) : null;
    } catch {
      return null;
    }
  }

  /**
   * Populate `job-phone-store` for this jobId like the worker pool does, so Booking OTP
   * selects the same masked number and email polling uses the same slot.
   */
  private async hydrateBookingOtpContactForPendingJob(
    jobId: string
  ): Promise<void> {
    const fromSlot =
      await phoneNumberSlotService.getOccupiedContactForJob(jobId);
    if (fromSlot) {
      setJobContact(jobId, fromSlot);
      await dualLogInfo(
        "Trust verification: OTP contact from phone_number_slots (Occupied)",
        { jobId }
      );
      return;
    }
    const fromPool = otpAwareWorkerPool.peekBookingOtpContactForJob(jobId);
    if (fromPool?.phone) {
      setJobContact(jobId, {
        phone: fromPool.phone,
        port: fromPool.port,
      });
      await dualLogInfo(
        "Trust verification: OTP contact from worker queue / in-memory job lock",
        { jobId }
      );
      return;
    }
    await dualLogWarn(
      "Trust verification: no phone lock or queue contact for this pending job — Booking OTP may fall back to OUR_CONTACT",
      { jobId }
    );
  }

  /**
   * Verify trust status for a single property
   */
  async verifyPropertyTrust(
    property: IProperty
  ): Promise<TrustVerificationResult> {
    const propertyId = property._id.toString();
    const bookingId = property.booking_id;
    const previousStatus =
      property.booking_trusted_status || BookingTrustedStatus.NotTrusted;

    await dualLogInfo(
      `Starting trust verification for property ${propertyId}`,
      {
        propertyId,
        bookingId,
        propertyName: property.property_name,
        previousStatus,
      }
    );

    try {
      const leaseJobId =
        await this.findOnePendingBookingJobIdForProperty(propertyId);
      const logJobKey = leaseJobId ?? propertyId;
      initializeJobLogging(logJobKey);

      // Create booking scraper instance
      const bookingScraper = new BookingScraper(
        ScraperContext.TRUST_VERIFICATION
      );
      bookingScraper.setPropertyIdForDb(propertyId);
      if (leaseJobId) {
        bookingScraper.setJobIdForTrustRun(leaseJobId);
        await this.hydrateBookingOtpContactForPendingJob(leaseJobId);
      }

      const { browser, page } = await bookingScraper.setupBrowser(
        leaseJobId ?? undefined
      );
      bookingScraper.setBrowserData(page, browser);

      // Attempt booking login
      try {
        const credentials = property.credentials?.[0];
        const password = credentials?.bookingPassword
          ? decryptPassword(credentials.bookingPassword)
          : undefined;

        await bookingScraper.login(
          {
            email: credentials?.bookingUsername!,
            password: password!,
          },
          property.booking_id.toString()
        );

        // Navigate to VCCS management page to verify card details access
        await dualLogInfo(
          `Navigating to VCCS management for property ${propertyId}`
        );

        let hasCardDetailsLinks = false;
        let newStatus = BookingTrustedStatus.NotTrusted;

        // Update property trust status
        await this.updatePropertyTrustStatus(propertyId, newStatus, new Date());

        try {
          await bookingScraper.navigateToMenuSection(
            "finance",
            "vccs_management",
            "vccs_management"
          );

          // Wait for the page to load and check for card details links
          const page = await bookingScraper.getPage();
          if (page) {
            // Wait for the table to load
            await page.waitForSelector(BOOKING_SELECTORS.vccs.table, {
              timeout: 10000,
            });

            // Check if there are any "View card details" links available and clickable (have href)
            hasCardDetailsLinks = await page.evaluate((selectors) => {
              const cardDetailLinks = document.querySelectorAll(selectors);
              let clickableLinks = 0;

              cardDetailLinks.forEach((link) => {
                const href = link.getAttribute("href");
                if (href && href.trim() !== "") {
                  clickableLinks++;
                }
              });

              return clickableLinks > 0;
            }, BOOKING_SELECTORS.vccs.viewCardDetailsLink);

            await dualLogInfo(
              `Card details verification for property ${propertyId}`,
              {
                hasCardDetailsLinks,
              }
            );
          }

          newStatus = hasCardDetailsLinks
            ? BookingTrustedStatus.Trusted
            : BookingTrustedStatus.NotTrusted;

          // Update property trust status
          await this.updatePropertyTrustStatus(
            propertyId,
            newStatus,
            new Date()
          );

          // Send notification if trust status changed
          if (previousStatus !== newStatus) {
            try {
              if (newStatus === BookingTrustedStatus.Trusted) {
                await notificationService.sendPublicNotification({
                  title: "Property Trusted on Booking.com",
                  message: `Property ${property.property_name} has been verified as Trusted and can now access card details`,
                  metadata: {
                    propertyId,
                    propertyName: property.property_name,
                    bookingId,
                    previousStatus,
                    newStatus,
                  },
                });
              } else {
                await notificationService.sendPublicNotification({
                  title: "Property Trust Status Changed",
                  message: `Property ${property.property_name} trust status changed to Not Trusted. Card details access may be limited`,
                  metadata: {
                    propertyId,
                    propertyName: property.property_name,
                    bookingId,
                    previousStatus,
                    newStatus,
                  },
                });
              }
            } catch (notificationError) {
              await dualLogError(
                `Error sending trust status change notification: ${notificationError}`
              );
            }
          }

          await dualLogInfo(
            `Trust verification completed for property ${propertyId}`,
            {
              propertyId,
              bookingId,
              previousStatus,
              newStatus,
              hasCardDetailsLinks,
              statusChanged: previousStatus !== newStatus,
            }
          );

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
            error:
              navigationError instanceof Error
                ? navigationError.message
                : String(navigationError),
          };
        }
      } catch (loginError) {
        await dualLogError(
          `Trust verification failed - login failed for property ${propertyId}`,
          loginError,
          { propertyId, bookingId, previousStatus }
        );

        // Send public notification for login failure
        try {
          await notificationService.sendPublicNotification({
            title: "Booking.com Login Failed",
            message: `Booking.com login failed for property ${property.property_name}. Credentials may be invalid or expired`,
            metadata: {
              propertyId,
              propertyName: property.property_name,
              bookingId,
              error:
                loginError instanceof Error
                  ? loginError.message
                  : String(loginError),
            },
          });
        } catch (notificationError) {
          await dualLogError(
            `Error sending login failure notification: ${notificationError}`
          );
        }

        await finalizeJobLogging("failed");

        return {
          propertyId,
          bookingId,
          previousStatus,
          newStatus: previousStatus,
          success: false,
          error:
            loginError instanceof Error
              ? loginError.message
              : String(loginError),
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
            `[${new Date().toISOString()}] Error processing property ${
              property._id
            } in trust scheduler`,
            {
              errorType: BookingErrorType.UNKNOWN,
              error: error,
              phase: BookingScrapingPhase.BUILDING_TRUST,
              platform: "booking",
              action: "run_trust_scheduler",
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

      // Send public notification for scheduler completion
      try {
        const runtimeMinutes = Math.round(this.stats.totalRuntime / 60000);
        await notificationService.sendPublicNotification({
          title: "Booking Trust Verification Completed",
          message: `Trust verification scheduler completed: ${this.stats.totalPropertiesChecked} properties checked, ${this.stats.successfulVerifications} successful, ${this.stats.newlyTrusted} newly trusted, ${this.stats.failedVerifications} failed. Runtime: ${runtimeMinutes} minute(s)`,
          metadata: {
            totalPropertiesChecked: this.stats.totalPropertiesChecked,
            successfulVerifications: this.stats.successfulVerifications,
            failedVerifications: this.stats.failedVerifications,
            newlyTrusted: this.stats.newlyTrusted,
            remainingUntrusted: this.stats.remainingUntrusted,
            totalRuntime: this.stats.totalRuntime,
            runtimeMinutes,
            completedAt: new Date().toISOString(),
          },
        });
      } catch (notificationError) {
        await dualLogError(
          `Error sending trust scheduler completion notification: ${notificationError}`
        );
      }

      return this.stats;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] Error in trust verification scheduler`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.BUILDING_TRUST,
          platform: "booking",
          action: "run_trust_scheduler",
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
  async verifySpecificProperty(
    propertyId: string
  ): Promise<TrustVerificationResult> {
    const property = await Property.findById(propertyId);
    if (!property) {
      throw new Error(`Property ${propertyId} not found`);
    }

    if (!property.booking_id || property.booking_id === 0) {
      throw new Error(`Property ${propertyId} has no valid booking_id`);
    }

    const credentials = await PropertyCredentials.findOne({
      property_id: property._id,
    });

    if (!credentials) {
      throw new Error(`Property ${propertyId} has no booking credentials`);
    }

    if (!credentials.bookingUsername || !credentials.bookingPassword) {
      throw new Error(`Property ${propertyId} has no booking credentials`);
    }

    property.credentials = [credentials];

    return await this.verifyPropertyTrust(property);
  }
}

// Export singleton instance
export const bookingTrustScheduler = new BookingTrustSchedulerService();
