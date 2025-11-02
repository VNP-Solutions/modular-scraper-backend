import dotenv from "dotenv";
import { Browser } from "puppeteer";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { BROWSER_CONFIG } from "./common/browser-constants.js";
import { delay } from "./common/delay.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { otpCompletionNotifier } from "./common/otp-completion-notifier.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import login from "./login/login.js";
import { CardInfo, PaymentInfo } from "./models/retrieval-item.model.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import {
  CreateRetrievalItemData,
  retrievalService,
} from "./services/retrieval.service.js";

dotenv.config();

/**
 * Make GraphQL API request to Expedia Partner Central for a specific reservation
 */
async function makeGraphQLRequestForReservation(
  cookieHeader: string,
  expediaId: string,
  reservationId: string
): Promise<any> {
  try {
    await dualLogInfo(
      `🚀 Making GraphQL API request for reservation: ${reservationId}`
    );

    // GraphQL query with searchParam set to the specific reservation ID
    const graphqlQuery = {
      query: `query getReservationsBySearchCriteria {
          reservationSearchV2(input: {
            propertyId: ${expediaId}, 
            booked: true, 
            externalBookingItemId: null, 
            canceled: true, 
            confirmationNumber: null, 
            confirmed: true, 
            startDate: "2025-10-19", 
            endDate: "2025-10-19", 
            dateType: "checkIn", 
            evc: false, 
            expediaCollect: true, 
            timezoneOffset: "-04:00", 
            firstName: null, 
            hotelCollect: true, 
            isSpecialRequest: false, 
            isVIPBooking: false, 
            lastName: null, 
            reconciled: false, 
            readyToReconcile: false, 
            returnBookingItemIDsOnly: false, 
            searchParam: "${reservationId}", 
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

    await dualLogInfo(
      `📊 GraphQL Response Status: ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      await dualLogError(
        `❌ GraphQL API Error Response: ${errorText}`,
        `Response Status: ${response.status} ${response.statusText}`
      );
      throw new Error(
        `GraphQL API failed with status ${response.status}: ${errorText}`
      );
    }

    const responseData = await response.json();
    await dualLogInfo(`✅ GraphQL API Response received for ${reservationId}`);

    return responseData;
  } catch (error: any) {
    await dualLogError(
      `Error in GraphQL request for reservation ${reservationId}:`,
      error.message
    );
    throw error;
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
  const baseDelayMs = parseInt(process.env.EVC_API_DELAY_MS || "4000"); // 4 seconds default

  while (attempt < maxRetries) {
    try {
      // Add delay before each request to avoid rate limiting
      if (attempt > 0) {
        // Exponential backoff for retries: 8s, 16s, 32s, 60s, 60s...
        const retryDelay = Math.min(8000 * Math.pow(2, attempt - 1), 60000);
        await dualLogInfo(
          `⏳ Retry delay: waiting ${retryDelay}ms before retry ${attempt}/${maxRetries}...`
        );
        await delay(retryDelay);
      } else {
        // Standard delay between normal requests to prevent rate limiting
        await dualLogInfo(
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

      await dualLogInfo(`💳 Fetching EVC card data...`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "*/*",
          "accept-language": "en-GB",
          "cache-control": "no-cache",
          "content-type": "application/json",
          "origin-request-id": generateRequestId(),
          pragma: "no-cache",
          origin: "https://apps.expediapartnercentral.com",
          referer: "https://apps.expediapartnercentral.com/",
          "sec-ch-ua":
            '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "user-agent": BROWSER_CONFIG.USER_AGENT,
          cookie: cookieHeader,
        },
        body: JSON.stringify(requestBody),
      });

      // Handle 429 (rate limit) specifically
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const waitTime = retryAfter
          ? parseInt(retryAfter) * 1000
          : 60000 + Math.random() * 30000; // 60-90 seconds

        await dualLogInfo(
          `⏳ Rate limited (429). Waiting ${Math.round(
            waitTime / 1000
          )}s before retry...`
        );
        await delay(waitTime);
        attempt++;
        continue; // Retry the request
      }

      if (!response.ok) {
        const errorText = await response.text();
        await dualLogError(
          `❌ EVC API Error: ${response.status} ${response.statusText}`,
          errorText
        );

        // For non-429 errors, retry with increasing delays
        if (attempt < maxRetries - 1) {
          attempt++;
          const errorDelay = Math.min(5000 * attempt, 30000); // Up to 30s for errors
          await dualLogInfo(
            `🔄 Retrying EVC API call (${attempt}/${maxRetries}) in ${errorDelay}ms due to ${response.status} error...`
          );
          await delay(errorDelay);
          continue;
        } else {
          await dualLogError(
            `❌ All retries exhausted. Returning error structure to continue processing.`,
            null
          );
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
      await dualLogInfo(`✅ EVC API Response received`);

      // Check if response contains actual card data
      const hasCardData =
        cardData &&
        ((cardData.cardInformation && cardData.cardInformation.cardNumber) ||
          cardData.cardNumber ||
          cardData.card_number);

      if (!hasCardData) {
        await dualLogInfo(
          `⚠️ EVC API returned response but no card data found`
        );

        // Error 20001 means card info doesn't exist for this reservation - this is normal
        if (cardData?.errorDetails?.errorCode === 20001) {
          await dualLogInfo(
            `ℹ️ Error 20001: Card information not found for this reservation (normal case)`
          );
        }

        return cardData; // Return the response anyway, let caller handle the empty data
      }

      // Success! Return the card data
      return cardData;
    } catch (error: any) {
      attempt++;
      await dualLogError(
        `❌ Error fetching EVC card data (attempt ${attempt}):`,
        error.message
      );

      if (attempt >= maxRetries) {
        await dualLogError(
          `❌ All retry attempts exhausted. Returning null to continue processing.`,
          null
        );
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
      await dualLogInfo(`🔄 Network error retry in ${networkDelay}ms...`);
      await delay(networkDelay);
    }
  }

  // This should never be reached, but just in case
  return null;
}

/**
 * Save GraphQL reservation data to RetrievalItem database
 */
async function saveGraphQLReservationToRetrievalItem(
  retrievalId: string,
  parentRetrievalId: string,
  propertyId: string,
  reservationItem: any,
  cardData: CardInfo | null,
  paymentData: PaymentInfo | null
): Promise<void> {
  try {
    // Extract basic reservation data
    const guestName = reservationItem.customer?.guestName || "Unknown Guest";
    const reservationId = reservationItem.reservationItemId || null;
    const confirmationNumber =
      reservationItem.confirmationInfo?.productConfirmationCode || null;
    const checkInDate = new Date(reservationItem.reservationInfo?.startDate);
    const checkOutDate = new Date(reservationItem.reservationInfo?.endDate);
    const roomType =
      reservationItem.reservationInfo?.product?.unitName || "Unknown";
    const bookingAmount =
      reservationItem.totalAmounts?.totalReservationAmount?.value || 0;
    const bookedDate = new Date(
      reservationItem.reservationInfo?.createDateTime
    );
    const reservationStatus =
      reservationItem.reservationInfo?.reservationAttributes?.stayStatus ||
      "Unknown";
    const additionalText =
      reservationItem.reservationInfo?.specialRequestDetails || null;

    // Create retrieval item data
    const retrievalItemData: CreateRetrievalItemData = {
      retrieval_id: retrievalId,
      parent_retrieval_id: parentRetrievalId,
      property_id: propertyId,
      guest_name: guestName,
      reservation_id: reservationId,
      confirmation_number: confirmationNumber,
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
      room_type: roomType,
      booking_amount: bookingAmount,
      booked_date: bookedDate,
      has_card_info: !!cardData,
      card_info: cardData || undefined,
      has_payment_info: !!paymentData,
      payment_info: paymentData || undefined,
      reservation_status: reservationStatus,
      additional_text: additionalText,
    };

    // Upsert to database (update if exists, create if not)
    await retrievalService.upsertRetrievalItem(retrievalItemData);
    await dualLogInfo(
      `✅ Saved/Updated reservation ${reservationId} to RetrievalItem database`,
      { retrievalId }
    );
  } catch (error: any) {
    await dualLogError(
      `❌ Failed to save reservation to RetrievalItem:`,
      error.message,
      { retrievalId }
    );
    throw error;
  }
}

/**
 * Main function to handle GraphQL-based retrieval scraping
 */
async function graphqlRetrievalScraping(
  retrievalId: string,
  reservationIds: string[],
  expediaId: string,
  userEmail: string,
  userPassword: string,
  jobId?: string
): Promise<void> {
  let browser: Browser | null = null;

  try {
    const environment = process.env.ENVIRONMENT || "production";

    await dualLogInfo("Setting up browser for GraphQL retrieval scraping...");
    let setupResult = null;
    if (environment === "production") {
      setupResult = await browserSetupProduction(undefined, "expedia");
    } else {
      setupResult = await browserSetupLocal(undefined, "expedia");
    }
    browser = setupResult.browser;
    const page = setupResult.page;
    await dualLogInfo("Browser setup complete. Page is ready at login screen.");

    // Login to Expedia
    await dualLogInfo("Performing automatic login...");
    try {
      await login(browser, page, userEmail, userPassword, jobId);
      await dualLogInfo("Login completed successfully!");
      await delay(10000);
    } catch (loginError) {
      await dualLogError("Login failed:", loginError);
      throw loginError;
    }

    // Handle OTP verification
    try {
      await handleOtpVerification(browser, page, jobId);
      await dualLogInfo("OTP verification completed successfully!");

      // Notify worker that OTP work is completed so other jobs can proceed
      if (jobId) {
        otpCompletionNotifier.notifyOtpCompleted(jobId);
      }
    } catch (error: any) {
      await dualLogError("OTP verification failed:", error);

      // Notify that OTP work is completed (even on failure) so other jobs can proceed
      if (jobId) {
        otpCompletionNotifier.notifyOtpCompleted(jobId);
      }

      throw error;
    }

    // Get cookies for API requests
    const cookies = await page.cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await dualLogInfo("Cookies extracted for GraphQL API requests");

    // Get retrieval details for parent_retrieval_id and property_id
    const retrieval = await retrievalService.getRetrievalById(retrievalId);
    if (!retrieval) {
      throw new Error(`Retrieval ${retrievalId} not found`);
    }
    const parentRetrievalId = retrieval.parent_retrieval_id.toString();
    const propertyId = retrieval.property_id?.toString();
    if (!propertyId) {
      throw new Error(`Property ID not found in retrieval ${retrievalId}`);
    }

    // Update progress
    scrapingStateManager.updateProgress(
      undefined,
      undefined,
      0,
      reservationIds.length
    );

    // Process each reservation ID
    let processedCount = 0;
    for (const reservationId of reservationIds) {
      // Check if scraping is paused and wait if needed
      await scrapingStateManager.waitWhilePaused();

      // Check if scraping was stopped while paused
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped, exiting...", null);
        break;
      }

      await dualLogInfo(
        `Processing reservation ${processedCount + 1}/${
          reservationIds.length
        }: ${reservationId}`
      );

      try {
        // Add human-like delay between reservations (random 2-5 seconds)
        if (processedCount > 0) {
          const humanDelay = Math.floor(Math.random() * 3000) + 2000; // 2-5 seconds
          await dualLogInfo(
            `⏳ Human-like delay: ${humanDelay}ms before next reservation...`
          );
          await delay(humanDelay);
        }

        // Make GraphQL request for this specific reservation
        const responseData = await makeGraphQLRequestForReservation(
          cookieHeader,
          expediaId,
          reservationId
        );

        // Process the response
        if (responseData.data && responseData.data.reservationSearchV2) {
          const reservationItems =
            responseData.data.reservationSearchV2.reservationItems || [];

          if (reservationItems.length > 0) {
            const item = reservationItems[0]; // Should only be one item for specific reservation ID

            await dualLogInfo(
              `📋 Found reservation data for ${reservationId}`,
              {
                guestName: item.customer?.guestName || "Unknown",
                confirmationNumber:
                  item.confirmationInfo?.productConfirmationCode || "N/A",
              }
            );

            // Initialize card data and payment data variables
            let cardData: CardInfo | null = null;
            let paymentData: PaymentInfo | null = null;
            let evcCardData: any | null = null;

            // Extract payment info
            const paymentInfo = item.paymentInfo || {};

            // If EVC card details exist, fetch the actual card data
            if (
              paymentInfo.evcCardDetailsExist &&
              paymentInfo.expediaVirtualCardResourceId
            ) {
              try {
                await dualLogInfo(
                  `💳 Fetching EVC card data for ${reservationId}...`
                );

                evcCardData = await fetchEVCCardData(
                  expediaId,
                  paymentInfo.expediaVirtualCardResourceId,
                  item.reservationItemId,
                  item.reservationInfo?.startDate,
                  cookieHeader
                );

                // Map EVC card data to CardInfo format
                if (evcCardData && evcCardData.cardInformation) {
                  const cardInfo = evcCardData.cardInformation;

                  // Map EVC charge status values to desired format
                  const mapReasonForCharge = (
                    graphqlReason: string
                  ): string => {
                    switch (graphqlReason?.toLowerCase()) {
                      case "deactivatedduetofullcharge":
                        return "Charged in full";
                      case "chargecompleted":
                        return "Charged in full";
                      case "partiallycharged":
                        return "Partially charged";
                      case "readytocharge":
                        return "Ready to charge";
                      case "deactivated":
                        return "Deactivated";
                      default:
                        return graphqlReason || "";
                    }
                  };

                  const cardNumber = cardInfo.cardNumber || "";
                  const expirationDate =
                    cardInfo.expirationDate || cardInfo.expiryDate || "";
                  const cvv = cardInfo.cvv || "";
                  const chargeStatus =
                    cardInfo.chargeStatus?.chargeStatus ||
                    cardInfo.reasonForCharge ||
                    "";

                  if (cardNumber && cvv) {
                    cardData = {
                      card_number: cardNumber,
                      expiry_date: expirationDate,
                      cvv: cvv,
                      reason_for_charge: mapReasonForCharge(chargeStatus),
                    };

                    await dualLogInfo(`✅ EVC card data mapped successfully`);
                  } else {
                    await dualLogInfo(
                      `⚠️ Missing essential card data for ${reservationId}`
                    );
                  }
                } else {
                  await dualLogInfo(
                    `⚠️ No valid card data in EVC response for ${reservationId}`
                  );
                }
              } catch (cardError: any) {
                await dualLogError(
                  `❌ Failed to fetch EVC card data for ${reservationId}:`,
                  cardError.message
                );
              }
            }

            // Extract payment information from reservation data
            if (item.totalAmounts) {
              // Extract amount to charge/refund from EVC card data if available
              let amountToChargeOrRefund = 0;
              if (evcCardData?.cardInformation?.availableBalance?.amount) {
                amountToChargeOrRefund =
                  evcCardData.cardInformation.availableBalance.amount;
              }

              paymentData = {
                total_guest_payment:
                  item.totalAmounts.totalReservationAmount?.value || 0,
                total_payout:
                  item.totalAmounts.totalAmountForPartners?.value || 0,
                amount_to_charge_or_refund: amountToChargeOrRefund,
              };
            }

            // Save to RetrievalItem database
            await saveGraphQLReservationToRetrievalItem(
              retrievalId,
              parentRetrievalId,
              propertyId,
              item,
              cardData,
              paymentData
            );
          } else {
            await dualLogInfo(
              `⚠️ No reservation data found for ${reservationId}`
            );
          }
        } else {
          await dualLogInfo(
            `⚠️ Invalid response structure for ${reservationId}`
          );
        }

        processedCount++;

        // Update progress
        scrapingStateManager.updateProgress(
          undefined,
          undefined,
          processedCount,
          reservationIds.length
        );
      } catch (error: any) {
        await dualLogError(
          `❌ Error processing reservation ${reservationId}:`,
          error.message
        );
        // Continue with next reservation even if this one fails
      }
    }

    await dualLogInfo(
      `✅ GraphQL retrieval scraping completed. Processed ${processedCount}/${reservationIds.length} reservations.`
    );

    // Close browser
    await dualLogInfo("All reservations processed, closing browser...");
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
  } catch (error: any) {
    await dualLogError("GraphQL retrieval scraping error:", error.message);
    // Close browser on error
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed due to error.");
    throw error;
  }
}

export default graphqlRetrievalScraping;
