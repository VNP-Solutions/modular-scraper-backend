import dotenv from "dotenv";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { BROWSER_CONFIG } from "./common/browser-constants.js";
import { delay } from "./common/delay.js";
import { emailNotifier } from "./common/email-notifier.js";
import { decryptPassword } from "./common/encription.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "./common/log-helper.js";
import { progressManager } from "./common/progress-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { timeManager } from "./common/time-manager.js";
import { getNextDateFromCompleted } from "./date-split/helper.js";
import login from "./login/login.js";
import { CardInfo, PaymentInfo } from "./models/job-item.model.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "./property-search/property-search.js";
import { jobQueueUrlService } from "./services/job-queue-url.service.js";
import { CreateJobItemData, jobService } from "./services/job.service.js";

dotenv.config();

/**
 * Make GraphQL API request to Expedia Partner Central
 */
async function makeGraphQLRequest(
  cookieHeader: string,
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string
): Promise<void> {
  try {
    console.log("🚀 Making GraphQL API request...");

    // Convert MM/DD/YYYY format to YYYY-MM-DD format if needed
    const formatDate = (dateStr: string): string => {
      if (!dateStr) return "2025-08-01";

      // If already in YYYY-MM-DD format, return as is
      if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return dateStr;
      }

      // If in MM/DD/YYYY format, convert to YYYY-MM-DD
      if (dateStr.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
        const [month, day, year] = dateStr.split("/");
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }

      // Default fallback
      return "2025-08-01";
    };

    const formattedStartDate = formatDate(startDate || "");
    const formattedEndDate = formatDate(endDate || "");

    console.log(`📅 Using dates: ${formattedStartDate} to ${formattedEndDate}`);
    console.log(`🏨 Property ID: ${expediaId}`);

    // Real Expedia GraphQL query based on your working curl command
    const graphqlQuery = {
      query: `query getReservationsBySearchCriteria {
          reservationSearchV2(input: {
            propertyId: ${expediaId || "39161277"}, 
            booked: true, 
            externalBookingItemId: null, 
            canceled: true, 
            confirmationNumber: null, 
            confirmed: true, 
            startDate: "${formattedStartDate}", 
            endDate: "${formattedEndDate}", 
            dateType: "checkOut", 
            evc: true, 
            expediaCollect: true, 
            timezoneOffset: "-05:00", 
            firstName: null, 
            hotelCollect: false, 
            isSpecialRequest: false, 
            isVIPBooking: false, 
            lastName: null, 
            reconciled: false, 
            readyToReconcile: false, 
            returnBookingItemIDsOnly: false, 
            searchParam: null, 
            unconfirmed: true, 
            searchForCancelWaiversOnly: false 
          }) { 
            reservationItems{
              reservationItemId 
              reservationInfo {
                reservationTpid 
                propertyId 
                startDate 
                endDate 
                createDateTime 
                brandDisplayName 
                newReservationItemId 
                country 
                reservationAttributes {
                  businessModel 
                  bookingStatus 
                  fraudCancelled 
                  fraudReleased 
                  stayStatus 
                  eligibleForECNoShowAndCancel 
                  strongCustomerAuthentication 
                  invoiced 
                  eligibleForCancelPolicyException 
                  supplierOperatingModel
                } 
                specialRequestDetails 
                accessibilityRequestDetails 
                product {
                  productTypeId 
                  unitName 
                  bedTypeName 
                  propertyVipStatus
                } 
                customerArrivalTime {
                  arrival
                }
                readyToReconcile 
                epsBooking 
              } 
              customer {
                id 
                guestName 
                phoneNumber 
                email 
                emailAlias 
                country 
                travelPurpose
              } 
              loyaltyInfo {
                loyaltyStatus 
                vipAmenities
              } 
              confirmationInfo {
                productConfirmationCode
              } 
              conversationsInfo {
                conversationsSupported 
                id 
                unreadMessageCount 
                conversationStatus 
                cpcePartnerId
              }
              totalAmounts {
                totalAmountForPartners {
                  value 
                  currencyCode
                }
                totalCommissionAmount {
                  value 
                  currencyCode
                }
                totalReservationAmount {
                  value 
                  currencyCode
                }
                propertyBookingTotal {
                  value 
                  currencyCode
                }
                totalReservationAmountInPartnerCurrency {
                  value 
                  currencyCode
                }
              }
              reservationActions {
                requestToCancel {
                  reason 
                  actionSupported 
                  actionUnsupportedBehavior {
                    hide 
                    disable
                  }
                }
                changeStayDates {
                  reason 
                  actionSupported
                }
                requestRelocation {
                  reason 
                  actionSupported
                }
                actionAttributes {
                  highFence
                }
                reconciliationActions {
                  markAsNoShow {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable 
                      openVa
                    }
                    virtualAgentParameters {
                      intentName 
                      taxonomyId
                    }
                  }
                  undoMarkNoShow {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                  changeCancellationFee {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                  resetCancellationFee {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                  markAsCancellation {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                  undoMarkAsCancellation {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                  changeReservationAmountsOrDates {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                  resetReservationAmountsOrDates {
                    reason 
                    actionSupported 
                    actionUnsupportedBehavior {
                      hide 
                      disable
                    }
                  }
                }
              }
              reconciliationInfo {
                reconciliationDateTime 
                reconciliationType 
                reconciliationStartDate 
                reconciliationEndDate
              }
              depositInfo {
                depositText 
                depositSchedules {
                  depositDueDate 
                  dueAmountCurrencyCode 
                  dueAmountValue 
                }
              }
              paymentInfo {
                evcCardDetailsExist 
                expediaVirtualCardResourceId 
                creditCardDetails { 
                  viewable 
                  viewCountLimit 
                  viewCountLeft 
                  viewCount 
                  hideCvvFromDisplay 
                  valid 
                  prevalidateCardOptIn 
                  cardValidationViewable 
                  inViewingWindow 
                  viewableWindow 
                  viewableOnDate 
                  viewableUntilDate 
                  validationInfo {
                    validationStatus 
                    validationType 
                    validationDate 
                    validationBy 
                    hasGuestProvidedNewCC 
                    newCreditCardReceivedDate 
                    is24HoursFromLastValidation 
                  } 
                }
              }
              billingInfo {
                invoiceNumber 
              }
              cancellationInfo {
                cancelDateTime 
                cancellationPolicy {
                  priceCurrencyCode 
                  costCurrencyCode 
                  policyType 
                  cancellationPenalties {
                    penaltyCost 
                    penaltyPrice 
                    penaltyPerStayFee 
                    penaltyTime 
                    penaltyInterval 
                    penaltyStartHour 
                    penaltyEndHour 
                  }
                  nonrefundableDatesList
                }
              }
              compensationDetails {
                reservationWaiverType 
                reservationFeeAmounts {
                  propertyWaivedFeeLineItem {
                    costCurrency 
                    costAmount 
                  }
                }
              }
              creditCardRecaptureDetails {
                validationStatus 
                validationTime 
                paymentPlanId 
                recapturePending 
                recaptureHoursPending
              } 
              reservationEligibility {
                isEligibleForCancel 
                isEligibleForRecapture 
                cancelIneligibleReasons
              } 
              searchWaiverRequest {
                serviceRequestId 
                type 
                typeDetails 
                state 
                orderNumber 
                partnerId 
                createdDate 
                srConversationId 
                lastUpdatedDate 
                notes {
                  text 
                  author {
                    firstName 
                    lastName 
                  }
                }
              }
            } 
            numOfCancelWaivers
          }
        }`,
      variables: {},
    };

    console.log("📤 Sending GraphQL Query:");
    console.log(JSON.stringify(graphqlQuery, null, 2));

    const response = await fetch(
      "https://api.expediapartnercentral.com/supply/experience/gateway/graphql",
      {
        method: "POST",
        headers: {
          ...BROWSER_CONFIG.GRAPHQL_HEADERS,
          "user-agent": BROWSER_CONFIG.USER_AGENT,
          cookie: cookieHeader,
        },
        body: JSON.stringify(graphqlQuery),
      }
    );

    console.log(
      `📊 GraphQL Response Status: ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ GraphQL API Error Response:", errorText);
      console.error(
        `❌ Response Status: ${response.status} ${response.statusText}`
      );
      console.error(
        `❌ Response Headers:`,
        Object.fromEntries(response.headers.entries())
      );
      throw new Error(
        `GraphQL API failed with status ${response.status}: ${errorText}`
      );
    }

    const responseData = await response.json();
    console.log(
      "✅ GraphQL API Response:",
      JSON.stringify(responseData, null, 2)
    );

    // Process the response data here
    if (responseData.data && responseData.data.reservationSearchV2) {
      const reservationItems =
        responseData.data.reservationSearchV2.reservationItems || [];
      console.log(`📋 Found ${reservationItems.length} reservation items`);

      // Log sample reservation data for debugging
      if (reservationItems.length > 0) {
        console.log(
          "📄 Sample reservation item:",
          JSON.stringify(reservationItems[0], null, 2)
        );

        // Get property_id from job for database storage
        let propertyIdForDb: string | null = null;
        if (jobId) {
          try {
            const job = await jobService.getJobById(jobId);
            if (job && job.property_id) {
              propertyIdForDb = job.property_id.toString();
              await dualLogInfo(
                `Using property_id: ${propertyIdForDb} for database storage`,
                { propertyIdForDb, jobId }
              );
            } else {
              await dualLogError(
                `Could not get property_id from job ${jobId}, will skip database storage`,
                null,
                { jobId }
              );
            }
          } catch (error: any) {
            await dualLogError(
              `Error getting property_id from job ${jobId}:`,
              error,
              { jobId }
            );
          }
        }

        // Process each reservation
        for (let index = 0; index < reservationItems.length; index++) {
          const item = reservationItems[index];
          const guestName = item.customer?.guestName || "Unknown Guest";
          const confirmationCode =
            item.confirmationInfo?.productConfirmationCode || "N/A";
          const checkIn = item.reservationInfo?.startDate || "N/A";
          const checkOut = item.reservationInfo?.endDate || "N/A";
          const paymentInfo = item.paymentInfo || {};

          console.log(`🏨 Reservation ${index + 1}:`);
          console.log(`   Guest: ${guestName}`);
          console.log(`   Confirmation: ${confirmationCode}`);
          console.log(`   Check-in: ${checkIn}`);
          console.log(`   Check-out: ${checkOut}`);
          console.log(
            `   Business Model: ${
              item.reservationInfo?.reservationAttributes?.businessModel ||
              "N/A"
            }`
          );
          console.log(
            `   Booking Status: ${
              item.reservationInfo?.reservationAttributes?.bookingStatus ||
              "N/A"
            }`
          );
          console.log(
            `   Total Amount: ${
              item.totalAmounts?.totalReservationAmount?.value || "N/A"
            } ${item.totalAmounts?.totalReservationAmount?.currencyCode || ""}`
          );
          console.log(
            `   EVC Card Details Exist: ${
              paymentInfo.evcCardDetailsExist || false
            }`
          );
          console.log(
            `   EVC Card Resource ID: ${
              paymentInfo.expediaVirtualCardResourceId || "N/A"
            }`
          );
          console.log(
            `   Credit Card Viewable: ${
              paymentInfo.creditCardDetails?.viewable || false
            }`
          );
          console.log(
            `   Card View Count Left: ${
              paymentInfo.creditCardDetails?.viewCountLeft || "N/A"
            }`
          );

          // Initialize card data and payment data variables
          let cardData: CardInfo | null = null;
          let paymentData: PaymentInfo | null = null;

          // If EVC card details exist, try to fetch the actual card data
          if (
            paymentInfo.evcCardDetailsExist &&
            paymentInfo.expediaVirtualCardResourceId
          ) {
            try {
              console.log(
                `💳 Fetching EVC card data for reservation ${index + 1}...`
              );
              const evcCardData = await fetchEVCCardData(
                expediaId || "",
                paymentInfo.expediaVirtualCardResourceId,
                item.reservationItemId,
                checkIn,
                cookieHeader
              );
              console.log(`✅ EVC Card Data:`, evcCardData);

              // Map EVC card data to CardInfo format
              if (evcCardData && evcCardData.cardNumber) {
                // Map GraphQL reason_for_charge values to desired format
                const mapReasonForCharge = (graphqlReason: string): string => {
                  switch (graphqlReason?.toLowerCase()) {
                    case "deactivatedduetofullcharge":
                      return "Charge is full";
                    case "partiallycharged":
                      return "Partially charged";
                    case "readytocharge":
                      return "Ready to charge";
                    default:
                      return graphqlReason || "";
                  }
                };

                cardData = {
                  card_number: evcCardData.cardNumber || "",
                  expiry_date: evcCardData.expiryDate || "",
                  cvv: evcCardData.cvv || "",
                  reason_for_charge: mapReasonForCharge(
                    evcCardData.reasonForCharge
                  ),
                };
              }
            } catch (cardError: any) {
              console.error(
                `❌ Failed to fetch EVC card data for reservation ${
                  index + 1
                }:`,
                cardError.message
              );
            }
          }

          // Save reservation data to database (only if we have valid database info)
          if (jobId && propertyIdForDb) {
            await saveGraphQLReservationToDatabase(
              jobId,
              propertyIdForDb,
              item,
              cardData,
              paymentData
            );
          }
        }
      }
    } else if (responseData.errors) {
      console.error("❌ GraphQL Errors:", responseData.errors);

      // Log specific error details for debugging
      responseData.errors.forEach((error: any, index: number) => {
        console.error(`❌ Error ${index + 1}:`, {
          message: error.message,
          path: error.path,
          extensions: error.extensions,
        });

        if (error.extensions?.exceptionDetails) {
          console.error(
            `❌ Exception Details ${index + 1}:`,
            error.extensions.exceptionDetails
          );
        }
      });

      throw new Error(
        `GraphQL query errors: ${JSON.stringify(responseData.errors)}`
      );
    } else {
      console.warn("⚠️ No reservation data found in response");
      console.log("📋 Full response structure:", Object.keys(responseData));
    }
  } catch (error: any) {
    console.error("❌ Error making GraphQL request:", error);
    await dualLogError("GraphQL API request failed", error, {
      jobId,
      expediaId,
      startDate,
      endDate,
    });
    throw error;
  }
}

/**
 * Helper function to save GraphQL reservation data to database
 */
async function saveGraphQLReservationToDatabase(
  jobId: string,
  propertyId: string,
  reservationItem: any,
  cardData: CardInfo | null,
  paymentData: PaymentInfo | null
): Promise<void> {
  try {
    // Validate jobId before processing
    if (!jobId || typeof jobId !== "string") {
      throw new Error(
        `Invalid jobId: ${jobId}. JobId must be a non-empty string.`
      );
    }

    if (!propertyId || typeof propertyId !== "string") {
      throw new Error(
        `Invalid propertyId: ${propertyId}. PropertyId must be a non-empty string.`
      );
    }

    // Check if jobId looks like a valid ObjectId (24 character hex string)
    if (!/^[0-9a-fA-F]{24}$/.test(jobId)) {
      throw new Error(
        `Invalid jobId format: ${jobId}. JobId must be a 24 character hexadecimal string (MongoDB ObjectId).`
      );
    }

    // propertyId should also be a valid ObjectId since it comes from the job's property_id
    if (!/^[0-9a-fA-F]{24}$/.test(propertyId)) {
      throw new Error(
        `Invalid propertyId format: ${propertyId}. PropertyId must be a 24 character hexadecimal string (MongoDB ObjectId).`
      );
    }

    // Parse dates from GraphQL response
    const parseDate = (dateStr: string): Date => {
      if (!dateStr) return new Date();

      // GraphQL dates are typically in ISO format or YYYY-MM-DD
      if (dateStr.includes("T")) {
        // ISO format: 2025-01-15T00:00:00Z
        return new Date(dateStr);
      } else if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        // YYYY-MM-DD format
        return new Date(dateStr);
      } else {
        // Try to parse as-is
        const parsed = new Date(dateStr);
        return isNaN(parsed.getTime()) ? new Date() : parsed;
      }
    };

    // Parse booking amount from GraphQL response
    const parseAmount = (amount: any): number => {
      if (!amount || typeof amount !== "object") return 0;
      const value = amount.value || amount.amount || 0;
      return typeof value === "number" ? value : parseFloat(value) || 0;
    };

    // Extract data from GraphQL reservation item
    const guestName = reservationItem.customer?.guestName || "Unknown Guest";
    const reservationId = reservationItem.reservationItemId || "";
    const confirmationCode =
      reservationItem.confirmationInfo?.productConfirmationCode || "";
    const checkInDate = reservationItem.reservationInfo?.startDate || "";
    const checkOutDate = reservationItem.reservationInfo?.endDate || "";
    const roomType =
      reservationItem.reservationInfo?.product?.unitName || "Unknown";
    const bookingAmount = parseAmount(
      reservationItem.totalAmounts?.totalReservationAmount
    );
    const bookedDate =
      reservationItem.reservationInfo?.createDateTime ||
      new Date().toISOString();
    const reservationStatus =
      reservationItem.reservationInfo?.reservationAttributes?.bookingStatus ||
      "Unknown";

    // Create additional text with business model and other relevant info
    const businessModel =
      reservationItem.reservationInfo?.reservationAttributes?.businessModel ||
      "";
    const additionalText = businessModel
      ? `Business Model: ${businessModel}`
      : undefined;

    const jobItemData: CreateJobItemData = {
      job_id: jobId,
      property_id: propertyId,
      guest_name: guestName,
      reservation_id: reservationId,
      confirmation_number: confirmationCode,
      check_in_date: parseDate(checkInDate),
      check_out_date: parseDate(checkOutDate),
      room_type: roomType,
      booking_amount: bookingAmount,
      booked_date: parseDate(bookedDate),
      has_card_info: !!cardData,
      card_info: cardData || undefined,
      has_payment_info: !!paymentData,
      payment_info: paymentData || undefined,
      reservation_status: reservationStatus,
      additional_text: additionalText,
    };

    const savedItem = await jobService.createJobItem(jobItemData);
    await dualLogInfo(
      `✅ Saved GraphQL reservation ${reservationId} to database`,
      { jobId }
    );
    return;
  } catch (dbError: any) {
    await dualLogError(
      `❌ Failed to save GraphQL reservation ${
        reservationItem?.reservationItemId || "unknown"
      } to database:`,
      dbError.message,
      { jobId }
    );

    // Log additional context for debugging
    await dualLogError(
      `Debug info - jobId: ${jobId}, propertyId: ${propertyId}`,
      null,
      { jobId }
    );

    // Don't rethrow the error to prevent stopping the entire scraping process
    // Just log it and continue with the next reservation
    return;
  }
}

/**
 * Fetch EVC card data for a specific reservation
 */
async function fetchEVCCardData(
  propertyId: string,
  cardResourceId: string,
  bookingItemId: string,
  checkInDate: string,
  cookieHeader: string
): Promise<any> {
  try {
    const url = `https://apps.expediapartnercentral.com/lodging/bookings/evc/getEVCCardDataByCardResourceId?htid=${propertyId}&cardResourceId=${encodeURIComponent(
      cardResourceId
    )}`;

    const requestBody = {
      bookingItemId: bookingItemId.toString(),
      checkInDate: checkInDate,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "*/*",
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
        "content-type": "application/json",
        dnt: "1",
        origin: "https://apps.expediapartnercentral.com",
        priority: "u=1, i",
        referer: "https://apps.expediapartnercentral.com/",
        "sec-ch-ua":
          '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        "origin-request-id": "7abd502b-052e-4fa6-8b9f-d46345363f36",
        cookie: cookieHeader,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `EVC API failed with status ${response.status}: ${errorText}`
      );
    }

    const cardData = await response.json();
    return cardData;
  } catch (error: any) {
    console.error("❌ Error fetching EVC card data:", error);
    throw error;
  }
}

async function graphqlScraping(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  expediaUsername?: string,
  expediaPassword?: string
): Promise<void> {
  let jobLogger = null;
  let browser = null;

  // Initialize time management
  await timeManager.startSession(jobId);

  try {
    // Initialize job logging if jobId is provided
    if (jobId) {
      jobLogger = initializeJobLogging(jobId);
      await dualLogInfo(`Starting job ${jobId}`, {
        expediaId,
        startDate,
        endDate,
        expediaUsername: expediaUsername ? "[REDACTED]" : undefined,
        timeSession: timeManager.getSessionInfo(),
      });

      // Check if job should resume from a specific date
      const resumeInfo = progressManager.shouldJobResume(jobId);
      if (resumeInfo.shouldResume && resumeInfo.resumeDate && startDate) {
        const nextStartDate = getNextDateFromCompleted(resumeInfo.resumeDate);
        await dualLogInfo(
          `Job resuming from date: ${nextStartDate} (last completed: ${resumeInfo.resumeDate})`,
          {
            jobId,
            originalStartDate: startDate,
            resumeStartDate: nextStartDate,
            lastProcessedDate: resumeInfo.resumeDate,
          }
        );
        startDate = nextStartDate;
      }
    }

    // const client = new Steel({
    //   steelAPIKey: process.env.STEEL_API_KEY, // Optional
    // });
    // Create a session with additional features
    // const session = await client.sessions.create({
    //   region: "lax",
    //   useProxy: true,
    //   solveCaptcha: true,
    // });
    // const debugUrl = session.debugUrl;
    // console.log(`Debug URL: ${debugUrl}`);
    // console.log(session);
    try {
      // Start the main scraping loop that handles browser restarts
      await runScrapingWithRestart(
        expediaId,
        startDate,
        endDate,
        jobId,
        expediaUsername,
        expediaPassword
      );

      // End time session on successful completion
      await timeManager.endSession();

      // Finalize logging with success status
      if (jobId) {
        await finalizeJobLogging("success");
      }
    } catch (error: any) {
      await dualLogError("Main function error:", error);

      // End time session on error
      await timeManager.endSession();

      // Clean up progress file on inner main function error
      if (jobId) {
        await progressManager.handleJobError(jobId, error);

        // Release URL back to Available status on error
        await jobQueueUrlService.handleJobCompletion(
          jobId,
          "Failed",
          error?.message || "Unknown error"
        );
      }

      // Finalize logging with failed status
      if (jobId) {
        await finalizeJobLogging("failed");
      }
      throw error;
    }
  } catch (error: any) {
    await dualLogError("Main function error:", error);

    // Send email notification for outer main function error
    if (jobId) {
      try {
        await emailNotifier.notifyJobError(
          jobId,
          error?.message || "Unknown error in outer main function",
          error,
          {
            stage: "outer_main_function",
            progressPercentage:
              progressManager.getJobProgress(jobId)?.progressPercentage,
            lastProcessedDate:
              progressManager.getJobLastProcessedDate(jobId) || undefined,
          }
        );
      } catch (emailError) {
        await dualLogError(
          "Failed to send error notification email:",
          emailError
        );
      }
    }

    // End time session on error
    await timeManager.endSession();

    // Clean up progress file on main function error
    if (jobId) {
      await progressManager.handleJobError(jobId, error);

      // Release URL back to Available status on outer error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        error?.message || "Unknown error"
      );
    }

    // Finalize logging with failed status
    if (jobId) {
      await finalizeJobLogging("failed");
    }
    throw error;
  }
}

async function runScrapingWithRestart(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  expediaUsername?: string,
  expediaPassword?: string
): Promise<void> {
  const environment = process.env.ENVIRONMENT || "production";
  let currentStartDate = startDate;
  let attemptCount = 0;
  const maxAttempts = 100; // Prevent infinite loops

  // Helper function to parse MM/DD/YYYY to Date object
  const parseDate = (dateStr: string): Date => {
    const [month, day, year] = dateStr.split("/").map(Number);
    return new Date(year, month - 1, day);
  };

  // Helper function to format Date object to MM/DD/YYYY
  const formatDate = (date: Date): string => {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  };

  // Helper function to compare dates in MM/DD/YYYY format
  const compareDates = (date1: string, date2: string): number => {
    const d1 = parseDate(date1);
    const d2 = parseDate(date2);
    return d1.getTime() - d2.getTime();
  };

  // Generate array of individual dates from start to end
  const generateDateRange = (start: string, end: string): string[] => {
    const dates: string[] = [];
    const startDateObj = parseDate(start);
    const endDateObj = parseDate(end);

    let currentDate = new Date(startDateObj);
    while (currentDate <= endDateObj) {
      dates.push(formatDate(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return dates;
  };

  // Get all individual dates to process
  const datesToProcess = generateDateRange(startDate!, endDate!);
  console.log(
    `📅 Date splitting: Processing ${datesToProcess.length} days individually`
  );
  console.log(`📅 Dates: ${datesToProcess.join(", ")}`);

  // Process each date individually
  for (let i = 0; i < datesToProcess.length; i++) {
    const singleDate = datesToProcess[i];
    console.log(
      `\n🗓️ Processing day ${i + 1}/${datesToProcess.length}: ${singleDate}`
    );

    // Reset attempt counter for each new date
    attemptCount = 0;
    let browser = null;
    let dateCompleted = false;

    // Retry logic for each individual date
    while (!dateCompleted && attemptCount < maxAttempts) {
      attemptCount++;

      try {
        await dualLogInfo(
          `Starting scraping attempt ${attemptCount} for date ${singleDate}`,
          {
            currentDate: singleDate,
            dayProgress: `${i + 1}/${datesToProcess.length}`,
            jobId,
            timeSession: timeManager.getSessionInfo(),
          }
        );

        // Step 1: Setup browser and navigate to login page
        await dualLogInfo("Setting up browser...");
        let setupResult = null;
        if (environment === "production") {
          setupResult = await browserSetupProduction(jobId);
        } else {
          setupResult = await browserSetupLocal(jobId);
        }
        browser = setupResult.browser;
        const page = setupResult.page;

        await dualLogInfo(
          "Browser setup complete. Page is ready at login screen."
        );

        // Check if scraping is paused and wait if needed
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          await browser.close();
          if (jobId) {
            await finalizeJobLogging("failed");
          }
          return;
        }

        // Step 2: Check if login credentials are provided
        const email = expediaUsername;
        const password = decryptPassword(expediaPassword);

        if (email && password) {
          await dualLogInfo(
            "Login credentials found, performing automatic login..."
          );

          try {
            // Check pause state before login
            await scrapingStateManager.waitWhilePaused();
            if (!scrapingStateManager.isRunning()) {
              await dualLogInfo("Scraping was stopped, exiting...");
              await browser.close();
              if (jobId) {
                await finalizeJobLogging("failed");
              }
              return;
            }

            await login(browser, page, email, password, jobId);
            await dualLogInfo(
              "Login completed successfully! User is now logged in."
            );

            // Add your post-login automation here
            await dualLogInfo("Ready for scraping operations...");
            await delay(10000);
          } catch (loginError) {
            await dualLogError("Login failed:", loginError);
            // Close browser when done with this attempt
            if (browser) {
              await browser.close();
              browser = null;
            }
            await dualLogInfo("Browser closed successfully.");
            throw loginError;
          }

          try {
            // Check pause state before OTP verification
            await scrapingStateManager.waitWhilePaused();
            if (!scrapingStateManager.isRunning()) {
              await dualLogInfo("Scraping was stopped, exiting...");
              await browser.close();
              if (jobId) {
                await finalizeJobLogging("failed");
              }
              return;
            }

            await handleOtpVerification(browser, page, jobId);
            await dualLogInfo("OTP verification completed successfully!");
          } catch (error: any) {
            await dualLogError("OTP verification failed:", error);

            // Close browser when done with this attempt
            if (browser) {
              await browser.close();
              browser = null;
            }
            await dualLogInfo("Browser closed successfully.");
            // Continue even if OTP fails as it might not be required
            throw error;
          }

          await dualLogInfo("Starting graphql scraping...");
          // page.on("request", (req) => {
          //   if (req.url().includes("graphql")) {
          //     console.log("GraphQL Headers:", req.headers());
          //   }
          // });

          // Step 3: Perform property search with the provided expedia ID
          if (expediaId) {
            try {
              // Check pause state before property search
              await scrapingStateManager.waitWhilePaused();
              if (!scrapingStateManager.isRunning()) {
                await dualLogInfo("Scraping was stopped, exiting...");
                await browser.close();
                if (jobId) {
                  await finalizeJobLogging("failed");
                }
                return;
              }

              await dualLogInfo(
                `Starting property search for Expedia ID: ${expediaId}`
              );
              await propertySearchAndClickReservation(
                browser,
                page,
                expediaId,
                jobId
              );
              await dualLogInfo(
                "Property search and reservation completed successfully!"
              );
            } catch (error: any) {
              await dualLogError("Property search failed:", error);

              throw error;
            }
          } else {
            await dualLogInfo(
              "No expedia ID provided, skipping property search."
            );
          }

          // Step 1: Navigate to login page and authenticate properly
          console.log("🔐 Starting proper authentication flow...");

          // First, go to the main login page
          await page.goto("https://apps.expediapartnercentral.com/", {
            waitUntil: "networkidle2",
            timeout: 30000,
          });

          // Wait for page to load and check if we need to login
          await delay(3000);

          // Check if we're already logged in by looking for logout button or user menu
          const isLoggedIn = await page.evaluate(() => {
            return (
              !document.querySelector('input[name="username"]') &&
              !document.querySelector('input[name="password"]') &&
              (document.querySelector('[data-testid="user-menu"]') ||
                document.querySelector(".user-menu") ||
                document.querySelector('[href*="logout"]'))
            );
          });

          if (!isLoggedIn) {
            console.log("🔑 Need to login - starting authentication...");

            // Look for login form
            const loginForm = await page.$(
              'form[action*="login"], form[action*="auth"], #loginForm'
            );

            if (loginForm) {
              // Fill in credentials
              await page.type(
                'input[name="username"], input[type="email"], #username',
                expediaUsername || ""
              );
              await page.type(
                'input[name="password"], input[type="password"], #password',
                expediaPassword || ""
              );

              // Submit the form
              await Promise.all([
                page.waitForNavigation({
                  waitUntil: "networkidle2",
                  timeout: 30000,
                }),
                page.click(
                  'button[type="submit"], input[type="submit"], .login-button'
                ),
              ]);

              console.log("✅ Login form submitted");
            } else {
              console.log(
                "⚠️ No login form found - might already be authenticated"
              );
            }
          } else {
            console.log("✅ Already logged in");
          }

          // Step 2: Navigate to reservations page to get proper session context
          console.log(
            "🔄 Navigating to reservations page for proper session cookies..."
          );
          await page.goto(
            "https://apps.expediapartnercentral.com/lodging/bookings",
            {
              waitUntil: "networkidle2",
              timeout: 30000,
            }
          );

          // Wait for the page to fully load and set all necessary cookies
          await delay(5000);

          // Get cookies specifically for the API domains
          const context = page.browserContext();
          const allCookies = await context.cookies();

          // Filter cookies for the relevant domains - EXPANDED to include all necessary domains
          const relevantDomains = [
            "expediapartnercentral.com",
            "api.expediapartnercentral.com",
            "apps.expediapartnercentral.com",
            ".expediapartnercentral.com", // Domain with dot prefix
            ".expedia.com", // Expedia main domain
            "expedia.com", // Expedia main domain
            ".expediagroup.com", // Expedia Group domain
            ".accounts.expediagroup.com", // Account domain
            // Bot management and security domains
            ".akamaized.net",
            ".akadns.net",
            // Analytics domains
            ".google-analytics.com",
            ".googletagmanager.com",
            ".doubleclick.net",
          ];

          // For GraphQL API, we need to be more permissive to capture all cookies
          // that might be required for bot detection and session management
          const apiCookies = allCookies.filter((cookie) => {
            // Include all cookies from relevant domains
            const domainMatch = relevantDomains.some(
              (domain) =>
                cookie.domain === domain ||
                cookie.domain.endsWith(domain) ||
                cookie.domain === "." + domain ||
                domain.endsWith(cookie.domain.replace(".", ""))
            );

            // Also include specific critical cookies regardless of domain
            const criticalCookieNames = [
              "epcsid",
              "EG_SESSIONTOKEN",
              "EPCSession",
              "JSESSIONID",
              "HMS",
              "MC1",
              "DUAID",
              "_abck",
              "bm_sz",
              "bm_sv",
              "ak_bmsc", // Bot management
              "_ga",
              "_gid",
              "_gat", // Google Analytics
              "AMCV_",
              "AMCVS_", // Adobe Analytics (partial match)
              "QuantumMetricUserID",
              "QuantumMetricSessionID", // Quantum Metric
              "OptanonConsent",
              "OptanonAlertBoxClosed", // Cookie consent
              "CRQS",
              "CRQSS",
              "currency",
              "linfo",
              "tpid",
              "iEAPID", // Expedia specific
            ];

            const criticalMatch = criticalCookieNames.some(
              (name) =>
                cookie.name === name ||
                cookie.name.startsWith(name) ||
                (name.endsWith("_") && cookie.name.startsWith(name))
            );

            return domainMatch || criticalMatch;
          });

          // Log all cookies for debugging
          console.log("🍪 All cookies found:", allCookies.length);
          console.log("📋 All domains found:", [
            ...new Set(allCookies.map((c) => c.domain)),
          ]);

          // Log API-relevant cookies
          console.log("🎯 API-relevant cookies found:", apiCookies.length);
          apiCookies.forEach((cookie) => {
            console.log(`  - ${cookie.name} (domain: ${cookie.domain})`);
          });

          // Create cookie header for GraphQL API
          const cookieHeader = apiCookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");

          console.log("🍪 Cookie Header to use in GraphQL API:");
          console.log(cookieHeader);

          // Also log important cookies individually
          const importantCookies = [
            "epcsid", // Critical session ID
            "EG_SESSIONTOKEN", // Critical session token
            "EPCSession", // Critical session
            "JSESSIONID", // Critical session ID
            "HMS", // Session tracking
            "MC1", // User identifier
            "DUAID", // Device identifier
            "_abck", // Bot management (critical!)
            "bm_sz", // Bot management
            "bm_sv", // Bot management
            "ak_bmsc", // Akamai bot management
            "_ga", // Google Analytics
            "_gid", // Google Analytics
            "QuantumMetricUserID", // Quantum Metric tracking
            "AMCV_C00802BE5330A8350A490D4C@AdobeOrg", // Adobe Analytics
            "evcsession", // EVC session (from your working curl)
            "ssoidp", // SSO ID provider
            "mdid", // Machine ID
            "rsk", // Risk token
          ];
          console.log("🔑 Important cookies check:");
          importantCookies.forEach((cookieName) => {
            const cookie = apiCookies.find((c) => c.name === cookieName);
            if (cookie) {
              console.log(
                `  ✅ ${cookieName}: ${cookie.value.substring(0, 50)}...`
              );
            } else {
              console.log(`  ❌ ${cookieName}: NOT FOUND`);
            }
          });

          // Now make the GraphQL API call with the extracted cookies
          if (cookieHeader && cookieHeader.length > 0) {
            console.log("🍪 Cookie header length:", cookieHeader.length);
            console.log(
              "🍪 Cookie header preview:",
              cookieHeader.substring(0, 200) + "..."
            );

            // Check if we have the critical cookies
            const hasCriticalCookies = importantCookies.some((cookieName) =>
              cookieHeader.includes(cookieName + "=")
            );

            if (!hasCriticalCookies) {
              console.warn(
                "⚠️ Missing critical cookies - authentication might be incomplete"
              );
            }

            // IMPORTANT: Keep browser open for GraphQL API call
            console.log("🔒 Making GraphQL API call while browser is open...");

            try {
              await makeGraphQLRequest(
                cookieHeader,
                expediaId,
                singleDate, // Use the current single date
                singleDate, // Same start and end date for single day
                jobId
              );

              console.log("✅ GraphQL API call completed successfully!");

              // Now it's safe to close the browser
              await dualLogInfo(
                "GraphQL API call completed, closing browser..."
              );
              if (browser) {
                await browser.close();
                browser = null;
              }
              await dualLogInfo(
                "Browser closed successfully after GraphQL API call."
              );

              // SUCCESS! This date is complete, move to next date
              console.log(
                `🎉 Day ${i + 1}/${
                  datesToProcess.length
                } (${singleDate}) completed successfully!`
              );

              // ✅ Data stored to database via GraphQL processing above

              dateCompleted = true; // Mark this date as completed
              break; // Exit the retry attempts for this date
            } catch (graphqlError: any) {
              console.error("❌ GraphQL API call failed:", graphqlError);

              // Close browser on GraphQL error
              if (browser) {
                try {
                  await browser.close();
                  browser = null;
                } catch (closeError) {
                  await dualLogError(
                    "Error closing browser after GraphQL failure:",
                    closeError
                  );
                }
              }

              throw graphqlError;
            }
          } else {
            console.error("❌ No valid cookies found for GraphQL API!");
            throw new Error(
              "Failed to extract proper session cookies for GraphQL API"
            );
          }
        } else {
          await dualLogInfo("No login credentials provided.");
          await dualLogInfo("Browser closed successfully.");
          // Close browser when done with this attempt
          if (browser) {
            await browser.close();
          }
          break; // Exit the retry loop
        }
      } catch (error: any) {
        await dualLogError(
          `Scraping attempt ${attemptCount} for date ${singleDate} failed:`,
          error
        );

        // Close browser on error (but only if it's not a GraphQL API error)
        if (browser && !error.message?.includes("GraphQL API")) {
          try {
            await browser.close();
          } catch (closeError) {
            await dualLogError("Error closing browser:", closeError);
          }
        }

        // For critical errors, stop processing all dates
        if (
          !(error instanceof Error) ||
          !error.message.startsWith("BROWSER_RESTART_NEEDED:")
        ) {
          // Clean up progress file on error
          if (jobId) {
            await progressManager.handleJobError(jobId, error);

            // Release URL back to Available status on browser crash
            await jobQueueUrlService.handleJobCompletion(
              jobId,
              "Failed",
              error?.message || "Unknown error"
            );
          }

          console.error(
            `❌ Critical error on date ${singleDate}, stopping all date processing`
          );
          throw error;
        }

        // For browser restart errors, retry this date
        // (attemptCount already incremented at start of while loop)
        console.log(
          `🔄 Retrying date ${singleDate}, attempt ${
            attemptCount + 1
          }/${maxAttempts}`
        );
      }
    } // End of retry while loop for this date

    if (!dateCompleted) {
      console.error(
        `❌ Failed to complete date ${singleDate} after ${maxAttempts} attempts, skipping to next date`
      );
    }

    // Add random delay between 1-10 seconds before processing next date (to avoid detection)
    if (i < datesToProcess.length - 1) {
      // Don't delay after the last date
      const randomDelay = Math.floor(Math.random() * 10) + 1; // Random number between 1-10
      console.log(
        `⏱️ Waiting ${randomDelay} seconds before processing next date...`
      );
      await dualLogInfo(
        `Adding ${randomDelay}s delay between dates to avoid detection`,
        {
          jobId,
          currentDate: singleDate,
          nextDate: datesToProcess[i + 1],
          delaySeconds: randomDelay,
        }
      );
      await delay(randomDelay * 1000); // Convert to milliseconds
      console.log(`✅ Delay complete, proceeding to next date...`);
    }
  } // End of date processing for loop

  console.log("🎉 All dates processed successfully!");
}

export default graphqlScraping;
