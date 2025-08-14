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
            timezoneOffset: "-04:00", 
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
          "client-name": "pc-reservations-web",
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

        // Process each reservation with delays to prevent rate limiting
        for (let index = 0; index < reservationItems.length; index++) {
          // Add delay between processing reservations to avoid overwhelming the API
          if (index > 0) {
            const reservationDelay = parseInt(
              process.env.RESERVATION_PROCESSING_DELAY_MS || "1000"
            ); // 1 second between reservations
            console.log(
              `⏳ Reservation processing delay: ${reservationDelay}ms...`
            );
            await delay(reservationDelay);
          }
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

          // Initialize card data and EVC data variables
          let cardData: CardInfo | null = null;
          let evcCardData: any = null;

          // If EVC card details exist, try to fetch the actual card data
          if (
            paymentInfo.evcCardDetailsExist &&
            paymentInfo.expediaVirtualCardResourceId
          ) {
            try {
              console.log(
                `💳 Fetching EVC card data for reservation ${index + 1}...`
              );
              evcCardData = await fetchEVCCardData(
                expediaId || "",
                paymentInfo.expediaVirtualCardResourceId,
                item.reservationItemId,
                checkIn,
                cookieHeader
              );
              console.log(`✅ EVC Card Data:`, evcCardData);

              // Map EVC card data to CardInfo format - Handle actual API response structure
              if (evcCardData && evcCardData.cardInformation) {
                const cardInfo = evcCardData.cardInformation;

                // Map EVC charge status values to desired format
                const mapReasonForCharge = (chargeStatus: string): string => {
                  switch (chargeStatus?.toLowerCase()) {
                    case "deactivatedduetofullcharge":
                      return "Charge is full";
                    case "partiallycharged":
                      return "Partially charged";
                    case "readytocharge":
                      return "Ready to charge";
                    default:
                      return chargeStatus || "";
                  }
                };

                // Extract data from the actual API response structure
                const cardNumber = cardInfo.cardNumber || "";
                const expirationDate =
                  cardInfo.expirationDate || cardInfo.expiryDate || "";
                const cvv = cardInfo.cvv || "";
                const chargeStatus =
                  cardInfo.chargeStatus?.chargeStatus ||
                  cardInfo.reasonForCharge ||
                  "";

                console.log(`🔍 Raw EVC card info:`, {
                  cardNumber: cardNumber
                    ? `${cardNumber.substring(0, 6)}****${cardNumber.substring(
                        cardNumber.length - 4
                      )}`
                    : "None",
                  expirationDate,
                  cvv: cvv ? "***" : "None",
                  chargeStatus,
                });

                if (cardNumber && cvv) {
                  cardData = {
                    card_number: cardNumber,
                    expiry_date: expirationDate,
                    cvv: cvv,
                    reason_for_charge: mapReasonForCharge(chargeStatus),
                  };

                  console.log(`✅ Mapped EVC card data:`, {
                    card_number: `${cardData.card_number.substring(
                      0,
                      6
                    )}****${cardData.card_number.substring(
                      cardData.card_number.length - 4
                    )}`,
                    expiry_date: cardData.expiry_date,
                    cvv: "***",
                    reason_for_charge: cardData.reason_for_charge,
                  });
                } else {
                  console.warn(
                    `⚠️ Missing essential card data (cardNumber: ${!!cardNumber}, cvv: ${!!cvv}) for reservation ${
                      index + 1
                    }`
                  );
                }
              } else if (
                evcCardData &&
                (evcCardData.cardNumber || evcCardData.card_number)
              ) {
                // Fallback for old/different response format
                console.log(
                  `🔄 Using fallback card data mapping for reservation ${
                    index + 1
                  }`
                );

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
                  card_number:
                    evcCardData.cardNumber || evcCardData.card_number || "",
                  expiry_date:
                    evcCardData.expiryDate || evcCardData.expiry_date || "",
                  cvv: evcCardData.cvv || evcCardData.securityCode || "",
                  reason_for_charge: mapReasonForCharge(
                    evcCardData.reasonForCharge ||
                      evcCardData.reason_for_charge ||
                      ""
                  ),
                };

                console.log(`✅ Mapped EVC card data (fallback):`, cardData);
              } else {
                console.warn(
                  `⚠️ No valid card data in EVC response for reservation ${
                    index + 1
                  }`
                );
                console.log(
                  `🔍 EVC Response structure:`,
                  Object.keys(evcCardData || {})
                );
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
              evcCardData
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

      // Check if this is a downstream service error (temporary issue)
      const isDownstreamError = responseData.errors.some(
        (error: any) =>
          error.extensions?.code === "DOWNSTREAM_SERVICE_ERROR" ||
          error.message?.includes("Downstream service error") ||
          error.extensions?.classification === "DATA_SOURCE_ERROR"
      );

      if (isDownstreamError) {
        console.warn(
          "⚠️ Detected downstream service error - this may be temporary"
        );
        await dualLogError(
          "Downstream service error detected - Expedia's API may be experiencing issues",
          `This is likely a temporary issue with Expedia's reservation search API. Error: ${responseData.errors[0]?.message}`,
          {
            jobId,
            expediaId,
            startDate,
            endDate,
            errorType: "DOWNSTREAM_SERVICE_ERROR",
          }
        );
      }

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
  evcCardData: any | null
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

    // Extract data from GraphQL reservation item - Updated field mappings
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

    // Set reservation status to "Expedia Collect" as specified
    const reservationStatus = "Expedia Collect";

    // Create payment data from GraphQL response and EVC data
    let paymentData: PaymentInfo | null = null;
    if (reservationItem.totalAmounts) {
      // Extract amount to charge/refund from EVC card data if available
      let amountToChargeOrRefund = 0;
      if (evcCardData?.cardInformation?.availableBalance?.amount) {
        amountToChargeOrRefund =
          evcCardData.cardInformation.availableBalance.amount;
      }

      paymentData = {
        total_guest_payment: parseAmount(
          reservationItem.totalAmounts.totalReservationAmount
        ),
        cancellation_fee: 0, // Not available in current response structure
        total_payout: parseAmount(
          reservationItem.totalAmounts.propertyBookingTotal
        ),
        amount_to_charge_or_refund: amountToChargeOrRefund,
      };
    }

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
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
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
 * Fetch EVC card data for a specific reservation with rate limiting and retry logic
 */
async function fetchEVCCardData(
  propertyId: string,
  cardResourceId: string,
  bookingItemId: string,
  checkInDate: string,
  cookieHeader: string
): Promise<any> {
  const maxRetries = 8;
  let attempt = 0;

  // Base delay between requests (configurable) - prevent rate limiting
  const baseDelayMs = parseInt(process.env.EVC_API_DELAY_MS || "4000"); // 3 seconds default between requests

  while (attempt < maxRetries) {
    try {
      // Add delay before each request to avoid rate limiting
      if (attempt > 0) {
        // Exponential backoff for retries: 8s, 16s, 32s, 60s, 60s...
        const retryDelay = Math.min(8000 * Math.pow(2, attempt - 1), 60000);
        console.log(
          `⏳ Retry delay: waiting ${retryDelay}ms before retry ${attempt}/${maxRetries}...`
        );
        await delay(retryDelay);
      } else {
        // Standard delay between normal requests to prevent rate limiting
        console.log(
          `⏳ Rate limiting protection: ${baseDelayMs}ms delay before EVC API call...`
        );
        await delay(baseDelayMs);
      }

      const url = `https://apps.expediapartnercentral.com/lodging/bookings/evc/getEVCCardDataByCardResourceId?htid=${propertyId}&cardResourceId=${encodeURIComponent(
        cardResourceId
      )}`;

      // Generate a unique origin-request-id for each request
      const generateRequestId = (): string => {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
          /[xy]/g,
          function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          }
        );
      };

      const requestBody = {
        bookingItemId: bookingItemId.toString(),
        checkInDate: checkInDate,
      };

      console.log(`💳 EVC API URL:`, url);
      console.log(`📋 EVC Request Body:`, requestBody);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "*/*",
          "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
          "content-type": "application/json",
          dnt: "1",
          origin: "https://apps.expediapartnercentral.com",
          priority: "u=1, i",
          referer: `https://apps.expediapartnercentral.com/lodging/bookings?htid=${propertyId}&bookingItemId=${bookingItemId}`,
          "sec-ch-ua":
            '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
          "origin-request-id": generateRequestId(), // Dynamic request ID
          cookie: cookieHeader,
        },
        body: JSON.stringify(requestBody),
      });

      // Handle rate limiting specifically - MUST get data
      if (response.status === 429) {
        attempt++;
        const retryAfter = response.headers.get("retry-after");
        const waitTime = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(15000 * attempt, 120000); // Up to 2 minutes

        console.log(
          `⚠️ Rate limited (429). Waiting ${waitTime}ms before retry ${attempt}/${maxRetries}...`
        );

        if (attempt >= maxRetries) {
          console.error(
            `❌ Max retries reached for rate limiting. Will retry with longer delay...`
          );
          // Wait longer and try once more
          await delay(180000); // 3 minutes
          attempt = 0; // Reset attempt counter for one more try
          continue;
        }

        await delay(waitTime);
        continue; // Retry the request
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `❌ EVC API Error: ${response.status} ${response.statusText}`
        );
        console.error(`❌ EVC API Response:`, errorText);

        // For non-429 errors, retry with increasing delays
        if (attempt < maxRetries - 1) {
          attempt++;
          const errorDelay = Math.min(5000 * attempt, 30000); // Up to 30s for errors
          console.log(
            `🔄 Retrying EVC API call (${attempt}/${maxRetries}) in ${errorDelay}ms due to ${response.status} error...`
          );
          await delay(errorDelay);
          continue;
        } else {
          console.error(
            `❌ All retries exhausted. Returning error structure to continue processing.`
          );
          // Return error structure but don't break the flow - we need data collection to continue
          return {
            cardInformation: null,
            bookingInformation: null,
            cardActivity: null,
            errorDetails: {
              errorCode: response.status,
              errorMessage: `API Error: ${response.statusText}`,
            },
            isBlackListed: false,
            newBookingItemId: null,
            isContractExpired: false,
            apiError: true,
            skipReason: `HTTP ${response.status}`,
          };
        }
      }

      const cardData = await response.json();
      console.log(`✅ EVC API Response:`, cardData);

      // Check if response contains actual card data - handle new API response structure
      const hasCardData =
        cardData &&
        // New API structure
        ((cardData.cardInformation && cardData.cardInformation.cardNumber) ||
          // Old API structure (fallback)
          cardData.cardNumber ||
          cardData.card_number);

      if (!hasCardData) {
        console.warn(
          `⚠️ EVC API returned response but no card data found:`,
          cardData
        );
        console.log(
          `🔍 Available keys in response:`,
          Object.keys(cardData || {})
        );

        // Error 20001 means card info doesn't exist for this reservation - this is normal
        if (cardData?.errorDetails?.errorCode === 20001) {
          console.log(
            `ℹ️ Error 20001: Card information not found for this reservation (normal case)`
          );
        }

        return cardData; // Return the response anyway, let caller handle the empty data
      }

      // Success! Return the card data
      return cardData;
    } catch (error: any) {
      attempt++;
      console.error(
        `❌ Error fetching EVC card data (attempt ${attempt}):`,
        error.message
      );

      if (attempt >= maxRetries) {
        console.error(
          `❌ All retry attempts exhausted. Returning null to continue processing.`
        );
        // Don't throw error, return null to continue with other reservations
        return {
          cardInformation: null,
          bookingInformation: null,
          cardActivity: null,
          errorDetails: {
            errorCode: -1,
            errorMessage: `Network/Connection Error: ${error.message}`,
          },
          isBlackListed: false,
          newBookingItemId: null,
          isContractExpired: false,
          networkError: true,
          skipReason: "Network Error",
        };
      }

      // Wait before retrying on network errors
      const networkDelay = Math.min(5000 * attempt, 20000);
      console.log(`🔄 Network error retry in ${networkDelay}ms...`);
      await delay(networkDelay);
    }
  }

  // This should never be reached, but just in case
  return null;
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

  // Setup browser ONCE for all dates (moved outside the date loop)
  let globalBrowser = null;
  let globalPage = null;
  let cookieHeader = "";

  try {
    // Browser setup happens ONCE for all dates
    await dualLogInfo("Setting up browser for all dates...");
    let setupResult = null;
    if (environment === "production") {
      setupResult = await browserSetupProduction(jobId);
    } else {
      setupResult = await browserSetupLocal(jobId);
    }
    globalBrowser = setupResult.browser;
    globalPage = setupResult.page;

    await dualLogInfo("Browser setup complete. Page is ready at login screen.");

    // Perform login ONCE for all dates
    const email = expediaUsername;
    const password = decryptPassword(expediaPassword);

    if (email && password) {
      await dualLogInfo(
        "Login credentials found, performing automatic login..."
      );

      try {
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          if (globalBrowser) await globalBrowser.close();
          if (jobId) await finalizeJobLogging("failed");
          return;
        }

        await login(globalBrowser, globalPage, email, password, jobId);
        await dualLogInfo(
          "Login completed successfully! User is now logged in."
        );
        await delay(5000); // Short delay after login

        // Handle OTP verification ONCE after login
        try {
          await scrapingStateManager.waitWhilePaused();
          if (!scrapingStateManager.isRunning()) {
            await dualLogInfo("Scraping was stopped, exiting...");
            if (globalBrowser) await globalBrowser.close();
            if (jobId) await finalizeJobLogging("failed");
            return;
          }

          await handleOtpVerification(globalBrowser, globalPage, jobId);
          await dualLogInfo("OTP verification completed successfully!");
        } catch (otpError: any) {
          await dualLogError("OTP verification failed:", otpError);
          // Don't fail the entire process for OTP - it might not be required
          await dualLogInfo(
            "Continuing without OTP verification (it might not be required)"
          );
        }

        // Extract session cookies ONCE (after OTP verification)
        const cookies = await globalPage.cookies();
        cookieHeader = cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");

        await dualLogInfo("Session cookies extracted for GraphQL API");
      } catch (loginError) {
        await dualLogError("Login failed:", loginError);
        if (globalBrowser) await globalBrowser.close();
        throw loginError;
      }
    } else {
      await dualLogInfo("No login credentials provided.");
    }

    // Process each date individually with the same browser session
    for (let i = 0; i < datesToProcess.length; i++) {
      const singleDate = datesToProcess[i];
      console.log(
        `\n🗓️ Processing day ${i + 1}/${datesToProcess.length}: ${singleDate}`
      );

      // Reset attempt counter for each new date
      attemptCount = 0;
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

          // Use the existing browser session (no new browser setup needed)
          await dualLogInfo("Using existing browser session...");

          // Check if browser is still alive
          if (!globalBrowser || globalBrowser.isConnected() === false) {
            throw new Error("Browser session lost, need to restart");
          }

          let browser = globalBrowser;
          let page = globalPage;

          await dualLogInfo(
            "Browser setup complete. Page is ready at login screen."
          );

          // Check if scraping is paused and wait if needed
          await scrapingStateManager.waitWhilePaused();
          if (!scrapingStateManager.isRunning()) {
            await dualLogInfo("Scraping was stopped, exiting...");
            if (jobId) {
              await finalizeJobLogging("failed");
            }
            return;
          }

          // GraphQL API call with retry logic
          try {
            // Add retry logic for GraphQL API calls
            let graphqlRetries = 0;
            const maxGraphqlRetries = 3;
            let graphqlSuccess = false;

            while (!graphqlSuccess && graphqlRetries < maxGraphqlRetries) {
              try {
                await makeGraphQLRequest(
                  cookieHeader,
                  expediaId,
                  singleDate, // Use the current single date
                  singleDate, // Same start and end date for single day
                  jobId
                );
                graphqlSuccess = true;
              } catch (graphqlRetryError: any) {
                graphqlRetries++;

                // Check if it's a downstream service error (worth retrying)
                const isRetryableError =
                  graphqlRetryError.message?.includes(
                    "DOWNSTREAM_SERVICE_ERROR"
                  ) ||
                  graphqlRetryError.message?.includes(
                    "Downstream service error"
                  );

                if (isRetryableError && graphqlRetries < maxGraphqlRetries) {
                  const retryDelay = Math.min(
                    1000 * Math.pow(2, graphqlRetries),
                    10000
                  ); // Exponential backoff, max 10s
                  console.warn(
                    `⚠️ GraphQL retry ${graphqlRetries}/${maxGraphqlRetries} in ${retryDelay}ms...`
                  );
                  await dualLogInfo(
                    `GraphQL API retry ${graphqlRetries}/${maxGraphqlRetries} after ${retryDelay}ms delay`,
                    {
                      jobId,
                      date: singleDate,
                      retryReason: "DOWNSTREAM_SERVICE_ERROR",
                    }
                  );
                  await delay(retryDelay);
                } else {
                  // Either not retryable or max retries reached
                  throw graphqlRetryError;
                }
              }
            }

            console.log("✅ GraphQL API call completed successfully!");

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
            throw graphqlError;
          }
        } catch (error: any) {
          await dualLogError(
            `Scraping attempt ${attemptCount} for date ${singleDate} failed:`,
            error
          );

          // For critical errors, stop processing all dates
          if (
            !(error instanceof Error) ||
            !error.message.startsWith("BROWSER_RESTART_NEEDED:")
          ) {
            // Clean up progress file on error
            if (jobId) {
              await progressManager.handleJobError(jobId, error);
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
        const randomDelay = Math.floor(Math.random() * 10) + 1;
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
  } catch (error: any) {
    // Handle any unexpected errors during the entire scraping process
    await dualLogError("Unexpected error during GraphQL scraping:", error);
    throw error;
  } finally {
    // Clean up browser session at the very end
    if (globalBrowser) {
      await dualLogInfo(
        "Cleaning up browser session after all dates processed..."
      );
      try {
        await globalBrowser.close();
        await dualLogInfo("Browser session closed successfully.");
      } catch (closeError) {
        await dualLogError("Error closing browser session:", closeError);
      }
    }
  }
}

export default graphqlScraping;
