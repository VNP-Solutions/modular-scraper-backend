import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Browser, Page } from "puppeteer";
import * as XLSX from "xlsx";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { BROWSER_CONFIG } from "./common/browser-constants.js";
import { delay } from "./common/delay.js";
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
import login from "./login/login.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "./property-search/property-search.js";
import { jobQueueUrlService } from "./services/job-queue-url.service.js";

dotenv.config();

// Helper functions for date manipulation
const parseDate = (dateStr: string): Date => {
  const [month, day, year] = dateStr.split("/").map(Number);
  return new Date(year, month - 1, day);
};

const formatDate = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
};

const formatDateForAPI = (dateStr: string): string => {
  const date = parseDate(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

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

// GraphQL API call function
async function makeGraphQLRequest(
  cookieHeader: string,
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string
): Promise<any[]> {
  if (!startDate || !endDate) {
    throw new Error("Start date and end date are required for GraphQL request");
  }

  const formattedStartDate = formatDateForAPI(startDate);
  const formattedEndDate = formatDateForAPI(endDate);

  console.log(`📊 Using dates: ${formattedStartDate} to ${formattedEndDate}`);
  console.log(`🏨 Property ID: ${expediaId}`);

  const graphqlQuery = {
    query: `query getReservationsBySearchCriteria {
      reservationSearchV2(input: {
        propertyId: ${expediaId}, 
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
        unconfirmed: true 
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

  console.log(
    "📤 Sending GraphQL Query:",
    JSON.stringify(graphqlQuery, null, 2)
  );

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
    console.error("GraphQL API Error Response:", errorText);
    throw new Error(`GraphQL API returned ${response.status}: ${errorText}`);
  }

  const responseData = await response.json();
  console.log(
    "📥 GraphQL Response Headers:",
    Object.fromEntries(response.headers.entries())
  );

  if (responseData.errors) {
    console.error(
      "GraphQL Errors:",
      JSON.stringify(responseData.errors, null, 2)
    );
    throw new Error(`GraphQL errors: ${JSON.stringify(responseData.errors)}`);
  }

  const reservationItems =
    responseData.data?.reservationSearchV2?.reservationItems || [];
  console.log(
    `📋 Found ${reservationItems.length} reservations for ${startDate}`
  );

  // Process reservations and fetch EVC data
  const processedReservations = [];

  for (let i = 0; i < reservationItems.length; i++) {
    const reservation = reservationItems[i];

    console.log(`🏨 Reservation ${i + 1}:`);
    console.log(`  Guest: ${reservation.customer?.guestName || "N/A"}`);
    console.log(
      `  Confirmation: ${
        reservation.confirmationInfo?.productConfirmationCode || "N/A"
      }`
    );
    console.log(
      `  Check-in: ${reservation.reservationInfo?.startDate || "N/A"}`
    );
    console.log(
      `  Check-out: ${reservation.reservationInfo?.endDate || "N/A"}`
    );
    console.log(
      `  Business Model: ${
        reservation.reservationInfo?.reservationAttributes?.businessModel ||
        "N/A"
      }`
    );
    console.log(
      `  Booking Status: ${
        reservation.reservationInfo?.reservationAttributes?.bookingStatus ||
        "N/A"
      }`
    );
    console.log(
      `  Total Amount: ${
        reservation.totalAmounts?.totalReservationAmount?.value || "N/A"
      } ${reservation.totalAmounts?.totalReservationAmount?.currencyCode || ""}`
    );
    console.log(
      `  EVC Card Details Exist: ${
        reservation.paymentInfo?.evcCardDetailsExist || false
      }`
    );
    console.log(
      `  EVC Card Resource ID: ${
        reservation.paymentInfo?.expediaVirtualCardResourceId || "N/A"
      }`
    );
    console.log(
      `  Credit Card Viewable: ${
        reservation.paymentInfo?.creditCardDetails?.viewable || false
      }`
    );
    console.log(
      `  Card View Count Left: ${
        reservation.paymentInfo?.creditCardDetails?.viewCountLeft || "N/A"
      }`
    );

    // Fetch EVC card data if it exists
    let evcCardData = null;
    if (
      reservation.paymentInfo?.evcCardDetailsExist &&
      reservation.paymentInfo?.expediaVirtualCardResourceId
    ) {
      try {
        console.log(`💳 Fetching EVC card data for reservation ${i + 1}...`);
        evcCardData = await fetchEVCCardData(
          reservation.paymentInfo.expediaVirtualCardResourceId,
          cookieHeader,
          reservation, // Pass the full reservation object
          expediaId // Pass the property ID
        );
        console.log("✅ EVC Card Data:", evcCardData);
      } catch (evcError: any) {
        console.error(
          `❌ Failed to fetch EVC card data for reservation ${i + 1}:`,
          evcError
        );
        evcCardData = { error: evcError.message || "Unknown EVC error" };
      }
    }

    // Combine reservation with EVC data
    processedReservations.push({
      ...reservation,
      evcCardData,
    });
  }

  return processedReservations;
}

// EVC Card Data Fetch Function
async function fetchEVCCardData(
  cardResourceId: string,
  cookieHeader: string,
  reservation: any, // Need reservation data for bookingItemId and checkInDate
  propertyId?: string
): Promise<any> {
  // Extract required data from reservation
  const bookingItemId = reservation.reservationItemId;
  const checkInDate = reservation.reservationInfo?.startDate; // Format: YYYY-MM-DD
  const htid = propertyId || reservation.reservationInfo?.propertyId;

  if (!bookingItemId || !checkInDate || !htid) {
    throw new Error(
      `Missing required EVC data: bookingItemId=${bookingItemId}, checkInDate=${checkInDate}, htid=${htid}`
    );
  }

  // Build URL with query parameters like your working curl
  const url = `https://apps.expediapartnercentral.com/lodging/bookings/evc/getEVCCardDataByCardResourceId?htid=${htid}&cardResourceId=${encodeURIComponent(
    cardResourceId
  )}`;

  console.log(`🔗 EVC API URL: ${url}`);
  console.log(
    `📋 EVC Request Data: bookingItemId=${bookingItemId}, checkInDate=${checkInDate}`
  );

  const evcResponse = await fetch(url, {
    method: "POST", // Still POST but with query params
    headers: {
      accept: "*/*",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      "content-type": "application/json",
      dnt: "1",
      origin: "https://apps.expediapartnercentral.com",
      "origin-request-id": `${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`, // Generate random request ID
      priority: "u=1, i",
      referer: `https://apps.expediapartnercentral.com/lodging/bookings?htid=${htid}&bookingItemId=${bookingItemId}`,
      "sec-ch-ua":
        '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": BROWSER_CONFIG.USER_AGENT,
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      bookingItemId: bookingItemId,
      checkInDate: checkInDate, // Use the reservation's check-in date
    }),
  });

  console.log(
    `📊 EVC Response Status: ${evcResponse.status} ${evcResponse.statusText}`
  );

  if (!evcResponse.ok) {
    const errorText = await evcResponse.text();
    console.error(`❌ EVC API Error Response: ${errorText}`);
    throw new Error(`EVC API returned ${evcResponse.status}: ${errorText}`);
  }

  return await evcResponse.json();
}

// Storage function for reservation data
async function storeReservationData(
  date: string,
  reservations: any[],
  jobId?: string
): Promise<void> {
  try {
    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Create filename with job ID and date
    const filename = `reservations_${jobId || "unknown"}_${date.replace(
      /\//g,
      "-"
    )}.json`;
    const filepath = path.join(dataDir, filename);

    // Prepare data for storage
    const dataToStore = {
      date,
      jobId,
      extractedAt: new Date().toISOString(),
      totalReservations: reservations.length,
      reservations: reservations.map((reservation, index) => ({
        sequenceNumber: index + 1,
        reservationItemId: reservation.reservationItemId,
        guestName: reservation.customer?.guestName || "N/A",
        confirmationCode:
          reservation.confirmationInfo?.productConfirmationCode || "N/A",
        checkInDate: reservation.reservationInfo?.startDate || "N/A",
        checkOutDate: reservation.reservationInfo?.endDate || "N/A",
        businessModel:
          reservation.reservationInfo?.reservationAttributes?.businessModel ||
          "N/A",
        bookingStatus:
          reservation.reservationInfo?.reservationAttributes?.bookingStatus ||
          "N/A",
        totalAmount:
          reservation.totalAmounts?.totalReservationAmount?.value || 0,
        currency:
          reservation.totalAmounts?.totalReservationAmount?.currencyCode ||
          "USD",
        propertyId: reservation.reservationInfo?.propertyId || "N/A",
        country: reservation.reservationInfo?.country || "N/A",
        email: reservation.customer?.email || "N/A",
        phoneNumber: reservation.customer?.phoneNumber || "N/A",
        evcCardExists: reservation.paymentInfo?.evcCardDetailsExist || false,
        evcCardResourceId:
          reservation.paymentInfo?.expediaVirtualCardResourceId || "N/A",
        creditCardViewable:
          reservation.paymentInfo?.creditCardDetails?.viewable || false,
        cardViewCountLeft:
          reservation.paymentInfo?.creditCardDetails?.viewCountLeft || 0,
        // EVC Card Details (if available)
        evcCardNumber:
          reservation.evcCardData?.cardInformation?.cardNumber || "N/A",
        evcCardCvv: reservation.evcCardData?.cardInformation?.cvv || "N/A",
        evcCardholderName:
          reservation.evcCardData?.cardInformation?.cardholderName || "N/A",
        evcActivationDate:
          reservation.evcCardData?.cardInformation?.activationDate || "N/A",
        evcExpirationDate:
          reservation.evcCardData?.cardInformation?.expirationDate || "N/A",
        evcAvailableBalance:
          reservation.evcCardData?.cardInformation?.availableBalance?.amount ||
          0,
        evcCurrency:
          reservation.evcCardData?.cardInformation?.availableBalance
            ?.currency || "N/A",
        evcChargeStatus:
          reservation.evcCardData?.cardInformation?.chargeStatus
            ?.chargeStatus || "N/A",
        evcBookingAmount:
          reservation.evcCardData?.bookingInformation?.bookingAmount?.amount ||
          0,
        evcBillingAddress: reservation.evcCardData?.cardInformation
          ?.billingAddress
          ? `${reservation.evcCardData.cardInformation.billingAddress.address_line1}, ${reservation.evcCardData.cardInformation.billingAddress.city_name}, ${reservation.evcCardData.cardInformation.billingAddress.state_province}, ${reservation.evcCardData.cardInformation.billingAddress.postal_code}, ${reservation.evcCardData.cardInformation.billingAddress.country_code}`
          : "N/A",
        evcError: reservation.evcCardData?.error || null,
        // Raw data for debugging
        rawReservationData: reservation,
      })),
    };

    // Write to JSON file
    fs.writeFileSync(filepath, JSON.stringify(dataToStore, null, 2));

    console.log(`📄 Data stored to: ${filepath}`);

    // Also create an XLSX summary for easy viewing
    await createXLSXSummary(date, dataToStore.reservations, jobId);

    // TODO: Add Google Sheets integration here
    // await appendToGoogleSheets(dataToStore);
    console.log(
      "📊 TODO: Integrate with Google Sheets for automatic data upload"
    );
  } catch (error: any) {
    console.error(`❌ Failed to store reservation data for ${date}:`, error);
    throw error;
  }
}

// Create XLSX summary for easy viewing
async function createXLSXSummary(
  date: string,
  reservations: any[],
  jobId?: string
): Promise<void> {
  try {
    const dataDir = path.join(process.cwd(), "data");
    const xlsxFilename = `summary_${jobId || "unknown"}_${date.replace(
      /\//g,
      "-"
    )}.xlsx`;
    const xlsxFilepath = path.join(dataDir, xlsxFilename);

    // Prepare data for Excel
    const worksheetData = [
      // Headers
      [
        "Sequence",
        "Guest Name",
        "Confirmation Code",
        "Check-in Date",
        "Check-out Date",
        "Business Model",
        "Booking Status",
        "Total Amount",
        "Currency",
        "Property ID",
        "Country",
        "Email",
        "Phone",
        "EVC Card Exists",
        "EVC Card Resource ID",
        "EVC Card Number",
        "EVC CVV",
        "EVC Cardholder Name",
        "EVC Activation Date",
        "EVC Expiration Date",
        "EVC Available Balance",
        "EVC Currency",
        "EVC Charge Status",
        "EVC Booking Amount",
        "EVC Billing Address",
        "Credit Card Viewable",
        "Card View Count Left",
        "EVC Error",
      ],
      // Data rows
      ...reservations.map((reservation) => [
        reservation.sequenceNumber,
        reservation.guestName,
        reservation.confirmationCode,
        reservation.checkInDate,
        reservation.checkOutDate,
        reservation.businessModel,
        reservation.bookingStatus,
        reservation.totalAmount,
        reservation.currency,
        reservation.propertyId,
        reservation.country,
        reservation.email,
        reservation.phoneNumber,
        reservation.evcCardExists ? "Yes" : "No",
        reservation.evcCardResourceId,
        reservation.evcCardNumber,
        reservation.evcCardCvv,
        reservation.evcCardholderName,
        reservation.evcActivationDate,
        reservation.evcExpirationDate,
        reservation.evcAvailableBalance,
        reservation.evcCurrency,
        reservation.evcChargeStatus,
        reservation.evcBookingAmount,
        reservation.evcBillingAddress,
        reservation.creditCardViewable ? "Yes" : "No",
        reservation.cardViewCountLeft,
        reservation.evcError || "",
      ]),
    ];

    // Create workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);

    // Set column widths for better readability
    worksheet["!cols"] = [
      { width: 10 }, // Sequence
      { width: 20 }, // Guest Name
      { width: 15 }, // Confirmation Code
      { width: 12 }, // Check-in Date
      { width: 12 }, // Check-out Date
      { width: 15 }, // Business Model
      { width: 15 }, // Booking Status
      { width: 12 }, // Total Amount
      { width: 8 }, // Currency
      { width: 12 }, // Property ID
      { width: 10 }, // Country
      { width: 25 }, // Email
      { width: 15 }, // Phone
      { width: 15 }, // EVC Card Exists
      { width: 30 }, // EVC Card Resource ID
      { width: 20 }, // EVC Card Number
      { width: 8 }, // EVC CVV
      { width: 20 }, // EVC Cardholder Name
      { width: 15 }, // EVC Activation Date
      { width: 15 }, // EVC Expiration Date
      { width: 18 }, // EVC Available Balance
      { width: 10 }, // EVC Currency
      { width: 15 }, // EVC Charge Status
      { width: 15 }, // EVC Booking Amount
      { width: 40 }, // EVC Billing Address
      { width: 18 }, // Credit Card Viewable
      { width: 18 }, // Card View Count Left
      { width: 20 }, // EVC Error
    ];

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(
      workbook,
      worksheet,
      `Reservations_${date.replace(/\//g, "-")}`
    );

    // Write XLSX file
    XLSX.writeFile(workbook, xlsxFilepath);
    console.log(`📊 XLSX summary created: ${xlsxFilepath}`);
  } catch (error: any) {
    console.error(`❌ Failed to create XLSX summary for ${date}:`, error);
  }
}

// Main refactored function with single browser for all dates
async function runScrapingWithRestart(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  expediaUsername?: string,
  expediaPassword?: string
): Promise<void> {
  const environment = process.env.ENVIRONMENT || "production";

  // Generate all dates to process
  const datesToProcess = generateDateRange(startDate!, endDate!);
  console.log(
    `📅 Date splitting: Processing ${datesToProcess.length} days individually`
  );
  console.log(`📅 Dates: ${datesToProcess.join(", ")}`);

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    // Setup browser ONCE for ALL dates
    console.log("🚀 Setting up browser for all dates...");
    let setupResult = null;

    if (environment === "production") {
      setupResult = await browserSetupProduction(jobId);
    } else {
      setupResult = await browserSetupLocal(jobId);
    }

    browser = setupResult.browser;
    page = setupResult.page;

    await dualLogInfo("Browser setup complete. Page is ready at login screen.");

    // Perform login ONCE for all dates
    const email = expediaUsername;
    const password = decryptPassword(expediaPassword);

    if (!email || !password) {
      throw new Error("Login credentials are required");
    }

    await dualLogInfo("Login credentials found, performing automatic login...");

    // Check pause state before login
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogInfo("Scraping was stopped, exiting...");
      if (browser) await browser.close();
      if (jobId) await finalizeJobLogging("failed");
      return;
    }

    await login(browser, page, email, password, jobId);
    await dualLogInfo("Login completed successfully! User is now logged in.");
    await delay(10000);

    // Handle OTP if needed
    try {
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo("Scraping was stopped, exiting...");
        if (browser) await browser.close();
        if (jobId) await finalizeJobLogging("failed");
        return;
      }

      await handleOtpVerification(browser, page, jobId);
      await dualLogInfo("OTP verification completed successfully!");
    } catch (error: any) {
      await dualLogError("OTP verification failed:", error);
      // Continue as OTP might not be required
    }

    // Property search ONCE for all dates
    if (expediaId) {
      await propertySearchAndClickReservation(browser, page, expediaId, jobId);
    }

    // Navigate to reservations page and get session cookies
    console.log("🔐 Starting proper authentication flow...");
    await page.goto("https://apps.expediapartnercentral.com/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(3000);

    // Navigate to reservations page to get proper session context
    console.log(
      "🔄 Navigating to reservations page for proper session cookies..."
    );
    await page.goto("https://apps.expediapartnercentral.com/lodging/bookings", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await delay(5000);

    // Extract cookies for API calls
    const context = page.browserContext();
    const allCookies = await context.cookies();

    const relevantDomains = [
      "expediapartnercentral.com",
      "api.expediapartnercentral.com",
      "apps.expediapartnercentral.com",
      ".expediapartnercentral.com",
      ".expedia.com",
      "expedia.com",
      ".expediagroup.com",
      ".accounts.expediagroup.com",
      ".akamaized.net",
      ".akadns.net",
      ".google-analytics.com",
      ".googletagmanager.com",
    ];

    const criticalCookieNames = [
      "epcsid",
      "EG_SESSIONTOKEN",
      "_abck",
      "bm_sz",
      "evcsession",
      "ssoidp",
      "mdid",
      "rsk",
    ];

    const apiCookies = allCookies.filter(
      (cookie) =>
        relevantDomains.some(
          (domain) =>
            cookie.domain.includes(domain) || domain.includes(cookie.domain)
        ) || criticalCookieNames.includes(cookie.name)
    );

    const cookieHeader = apiCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    console.log(`🍪 All cookies found: ${allCookies.length}`);
    console.log(`🎯 API-relevant cookies found: ${apiCookies.length}`);

    if (!cookieHeader || cookieHeader.length === 0) {
      throw new Error(
        "Failed to extract proper session cookies for GraphQL API"
      );
    }

    console.log("🍪 Cookie header length:", cookieHeader.length);
    console.log(
      "🍪 Cookie header preview:",
      cookieHeader.substring(0, 200) + "..."
    );

    // Process each date individually with the SAME browser session
    const allResults = [];

    for (let i = 0; i < datesToProcess.length; i++) {
      const singleDate = datesToProcess[i];
      console.log(
        `\n🗓️ Processing day ${i + 1}/${datesToProcess.length}: ${singleDate}`
      );

      try {
        // Make GraphQL API call for this specific date
        console.log("🔒 Making GraphQL API call while browser stays open...");
        const dayResults = await makeGraphQLRequest(
          cookieHeader,
          expediaId,
          singleDate,
          singleDate,
          jobId
        );

        console.log(
          `✅ Day ${i + 1}/${
            datesToProcess.length
          } (${singleDate}) completed successfully!`
        );
        console.log(
          `📋 Found ${dayResults.length} reservations for ${singleDate}`
        );

        // Store data for this day
        allResults.push({
          date: singleDate,
          reservations: dayResults,
          count: dayResults.length,
        });

        // Store data to CSV/spreadsheet
        await storeReservationData(singleDate, dayResults, jobId);
        console.log(
          `📊 ✅ Stored ${dayResults.length} reservations to storage for ${singleDate}`
        );

        // Small delay between dates
        await delay(2000);
      } catch (dateError: any) {
        console.error(`❌ Failed to process date ${singleDate}:`, dateError);
        // Continue with next date instead of stopping everything
        allResults.push({
          date: singleDate,
          error: dateError.message,
          reservations: [],
          count: 0,
        });
      }
    }

    // Final summary
    const totalReservations = allResults.reduce(
      (sum, day) => sum + day.count,
      0
    );
    const successfulDays = allResults.filter((day) => !day.error).length;

    console.log("\n🎉 ALL DATES PROCESSING COMPLETED!");
    console.log(`📊 Summary:`);
    console.log(`  - Total days processed: ${datesToProcess.length}`);
    console.log(`  - Successful days: ${successfulDays}`);
    console.log(`  - Failed days: ${datesToProcess.length - successfulDays}`);
    console.log(`  - Total reservations found: ${totalReservations}`);
  } finally {
    // Close browser only at the very end
    if (browser) {
      console.log("🔐 Closing browser after ALL dates completed...");
      await browser.close();
      console.log("✅ Browser closed successfully after processing all dates.");
    }
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
  try {
    if (jobId) {
      await initializeJobLogging(jobId);
    }

    timeManager.startSession(jobId);

    await runScrapingWithRestart(
      expediaId,
      startDate,
      endDate,
      jobId,
      expediaUsername,
      expediaPassword
    );

    if (jobId) {
      await finalizeJobLogging("success");
    }
  } catch (error: any) {
    console.error("GraphQL scraping failed:", error);

    if (jobId) {
      await progressManager.handleJobError(jobId, error);
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        error?.message || "Unknown error"
      );
      await finalizeJobLogging("failed");
    }

    throw error;
  }
}

export default graphqlScraping;
