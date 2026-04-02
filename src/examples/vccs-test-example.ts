/**
 * Example script demonstrating how to use the new VCCS Management API
 *
 * This script shows how to:
 * 1. Extract URL parameters from a VCCS management page
 * 2. Make API calls to get VCCS data
 * 3. Process individual reservations to get card details
 * 4. Store the data in the database
 */

import { vccsManagementService } from "../services/vccs-management.service.js";

// Example usage of the VCCS Management Service
async function testVccsManagement() {
  try {
    console.log("🚀 Starting VCCS Management Test...");

    // Example VCCS management page URL (replace with actual URL from your browser)
    const vccsUrl =
      "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=xu&hotel_id=5827700&ses=345ba6afcadf83888519d25944febe30&route=vccs_to_charge";

    // Example cookies (replace with actual cookies from your browser session)
    const cookies =
      "pcm_consent=analytical%3Dtrue%26countryCode%3DUS%26consentId%3De3cf3f0d-f19a-4e46-94bb-a1c3bf191144%26consentedAt%3D2025-09-08T06%3A37%3A11.132Z%26expiresAt%3D2026-03-07T06%3A37%3A11.132Z%26implicit%3Dtrue%26marketing%3Dtrue%26regionCode%3DNY%26regulation%3Dnone%26legacyRegulation%3Dnone; bkng_sso_session=e30; bkng_sso_ses=e30; bkng_bfp=c79900af02366ae6142db12a31db4427; uz=e; external_host=account.booking.com; _gcl_au=1.1.694162309.1757418019; _mkto_trk=id:261-NRZ-371&token:_mch-booking.com-d35c3e1a167cf6fc56339dca3c3379ed; _sfid_2a26={%22anonymousId%22:%2287e6e4e7c7ca5dff%22%2C%22consents%22:[]}; _fbp=fb.1.1757418022559.555933349388405209; extranet_cors_js=1; _gid=GA1.2.1130317312.1759302432; ecid=tqC%2B65We8BGpU9XsogAq4QLK; bkng=11UmFuZG9tSVYkc2RlIyh9Yaa29%2F3xUOLbof7CEiNviT%2BQTbZQ6krX%2BaMhrbQ7KGvRSyfXUceok3MW8LORZeevTa6qrUTUtes6DiiUfTkgMU%2Bzu0%2FPV4QIN%2Bfl45wToI6Gw3OVrO0SM8vt4ZGt0vMGxTPHdCAeoeygCb7nwUCsLIcNXCphNZbtIT3uaoyf1xjWL9%2Bv6HvpGEk%3D; bkng_sso_auth=CAIQm8CWywYaZuw2CczWVcNM7EdqB22LqrGacS/IiQXfY/GDck+hvmrIs+mbHXSQpKzNV1Yc3y0kRgk20zZjDA1nlCwD9j2TvEsfslA7vpGKPonhsbkZWD/gbVWhb/G6PLw7zUU5QK/M85/pscu4RA==; _evga_c2e4={%22uuid%22:%2287e6e4e7c7ca5dff%22%2C%22puid%22:%22hT9SDhHANLRVKEW7oWpCQXvsdXj9H3jKvN3egG454p-t-YCbcmzwdFRvRcKFjGX2cNsx4vLqvAGYdwEStRA5c6snLXuohLc97rXNO_A7eXU%22%2C%22affinityId%22:%220ar%22}; sadm=02UmFuZG9tSVYkc2RlIyh9YbxZGyl9Y5%2BPod1brrXMSEOQbCcsDDpLxFMShkJ2WYiddtcWBtCEnrc%3D; _sg_b_v=11%3B33653%3B1759391278; OptanonConsent=isGpcEnabled=0&datestamp=Thu+Oct+02+2025+14%3A07%3A13+GMT%2B0600+(Bangladesh+Standard+Time)&version=202408.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=004007ba-744c-4356-aedc-d71c694c0a1d&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0004%3A1&AwaitingReconsent=false; _ga=GA1.1.1340447079.1757414472; aws-waf-token=b4b74117-38b0-453b-a3ca-5cce48857bc3:EQoAYTM4hBdHAAAA:EIBsvbtsP97I+orhp2MlUnthG8IQbDaHE96rN6jSvs99VNSHlNvZO40GdXkNACP6UDAYqDfNc1/eAu6wctPYsd1oVFYMkdlk1Ow10t4QD04YbG2ZT8c38R1o3JOsnV7nxu9bq67hnpfooFRkOIU/nM5uvwO9nO9VJa9SMqK07WF3uheWyiPjUJ4t0tAix7NYcePxAnAi/Q7RIepx7S4vVP4uIKx/JmwBVlLUOwR7RO7AEEl7SgwjCW5mM2J2u1XcUX59lKAgV4V+i7M=; esadm=02UmFuZG9tSVYkc2RlIyh9YbxZGyl9Y5%2BPn3ikqlTVghbVvTFKuDFNHqb4npFyi57FmFU%2BlFAa5PY%3D; _ga_NQ1YHY3J83=GS2.1.s1759389612$o14$g1$t1759392847$j43$l0$h0";

    // Example headers (optional - these can be extracted from the browser)
    const headers = {
      "x-booking-csrf":
        "7WreaAAAAAA=vKT9JiwsUKqb7uSBEo-PkluRbJNmD__FApeWnlAQzwLO2_sUptAIMfNERmoqAYuW2L9Dnky3cmMBdxM22zjgA8WhL0D7zJ0nyo61E7Kxe5BXP2geYw_agNxzLpogqEDtAb6BSVKd1haB5d2wTq-U2RnRN1OHbvyiDgBybRDduZV-QZGT2layUZWaMkk",
      "x-booking-pageview-id": "89a33916cf3e039d",
    };

    // Step 1: Extract URL parameters
    console.log("📋 Step 1: Extracting URL parameters...");
    const urlParams = vccsManagementService.extractUrlParams(vccsUrl);

    if (!urlParams) {
      throw new Error("Failed to extract URL parameters");
    }

    console.log("✅ URL parameters extracted:", urlParams);

    // Step 2: Get VCCS data from API
    console.log("🌐 Step 2: Getting VCCS data from API...");
    const vccsData = await vccsManagementService.getVccsData(
      urlParams,
      cookies,
      headers
    );

    if (!vccsData || !vccsData.success) {
      throw new Error("Failed to get VCCS data from API");
    }

    console.log("✅ VCCS data retrieved:", {
      totalVccs: vccsData.data.vccs.length,
      totalAmount: vccsData.data.total_amount.amount_formatted,
      currency: vccsData.data.total_amount.currency,
    });

    // Step 3: Process all VCCS reservations
    console.log("🔄 Step 3: Processing all VCCS reservations...");
    const processingResult =
      await vccsManagementService.processAllVccsReservations(
        vccsData,
        urlParams,
        cookies,
        headers,
        "test-job-123", // jobId
        "test-property-456" // propertyId
      );

    console.log("✅ VCCS processing completed:", {
      processed: processingResult.processed,
      skippedResume: processingResult.skippedResume,
      errors: processingResult.errors,
      total: processingResult.results.length,
    });

    // Step 4: Display results
    console.log("📊 Step 4: Processing results:");
    processingResult.results.forEach((result, index) => {
      console.log(`\n--- Reservation ${index + 1} ---`);
      console.log(`Reservation ID: ${result.reservationId}`);
      console.log(`VCCS Amount: ${result.vccsData.current_amount.formatted}`);
      console.log(`Expiry Date: ${result.vccsData.expiry_date}`);
      console.log(
        `Card Details Retrieved: ${result.cardDetails ? "Yes" : "No"}`
      );
      console.log(`Saved to Database: ${result.saved ? "Yes" : "No"}`);

      if (result.cardDetails) {
        console.log(`Card Number: ${result.cardDetails.cardNumber}`);
        console.log(`Cardholder: ${result.cardDetails.cardholder}`);
        console.log(`Expiry: ${result.cardDetails.expiry}`);
        console.log(`CVV: ${result.cardDetails.cvv}`);
        console.log(
          `Amount to Charge: ${result.cardDetails.amountToChargeOrRefund}`
        );
        console.log(`Card Type: ${result.cardDetails.reasonForCharge}`);
      }
    });

    console.log("\n🎉 VCCS Management test completed successfully!");
  } catch (error) {
    console.error("❌ VCCS Management test failed:", error);
  }
}

// Example of getting card details for a single reservation
async function testSingleCardDetails() {
  try {
    console.log("\n🔍 Testing single card details retrieval...");

    const urlParams = {
      hotel_id: "5827700",
      ses: "345ba6afcadf83888519d25944febe30",
      lang: "xu",
      route: "vccs_to_charge",
    };

    const cookies = "your-cookies-here"; // Replace with actual cookies
    const reservationId = "6794005784"; // Example reservation ID

    const cardDetails = await vccsManagementService.getCardDetails(
      reservationId,
      urlParams,
      cookies
    );

    if (cardDetails) {
      console.log("✅ Card details retrieved:", cardDetails);
    } else {
      console.log("❌ Failed to retrieve card details");
    }
  } catch (error) {
    console.error("❌ Single card details test failed:", error);
  }
}

// Run the tests
if (import.meta.url === `file://${process.argv[1]}`) {
  testVccsManagement()
    .then(() => testSingleCardDetails())
    .catch(console.error);
}

export { testSingleCardDetails, testVccsManagement };
