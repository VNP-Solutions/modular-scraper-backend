import { Page } from "puppeteer";
import { BROWSER_CONFIG } from "../common/browser-constants.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";

/**
 * Helper function to convert MM/DD/YYYY to YYYY-MM-DD format
 */
function convertToYYYYMMDD(dateStr: string): string {
  const [month, day, year] = dateStr.split("/");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Make DB API request to Expedia Partner Central
 */
export async function makeDBApiRequest(
  page: Page,
  expediaId: string,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<any> {
  try {
    await dualLogInfo("🚀 Making DB API request...", {
      expediaId,
      startDate,
      endDate,
      jobId,
    });

    // Convert dates from MM/DD/YYYY to YYYY-MM-DD format
    const formattedStartDate = convertToYYYYMMDD(startDate);
    const formattedEndDate = convertToYYYYMMDD(endDate);

    await dualLogInfo(
      `📅 Formatted dates: ${formattedStartDate} to ${formattedEndDate}`
    );

    // Extract cookies from the page (after login and OTP verification)
    const cookies = await page.cookies();
    const cookieHeader = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    await dualLogInfo("🍪 Session cookies extracted for DB API");

    // Build the API URL
    const apiUrl = `https://apps.expediapartnercentral.com/lodging/finance/getReservationDetailsByDates.json?htid=${expediaId}&start=${formattedStartDate}&end=${formattedEndDate}`;

    await dualLogInfo(`🔗 API URL: ${apiUrl}`);

    // Make the API call using page.evaluate (runs in browser context)
    const responseData = await page.evaluate(
      async (url, cookieHeader, userAgent) => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json, text/javascript, */*; q=0.01",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "sec-ch-ua":
              '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": userAgent,
            "x-requested-with": "XMLHttpRequest",
            referer: `https://apps.expediapartnercentral.com/lodging/finance/ecInvoiceManualCreate.html?htid=${
              url.split("htid=")[1]?.split("&")[0] || ""
            }`,
            origin: "https://apps.expediapartnercentral.com",
            priority: "u=1, i",
          },
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error(
            `DB API request failed with status: ${response.status} ${response.statusText}`
          );
        }

        return await response.json();
      },
      apiUrl,
      cookieHeader,
      BROWSER_CONFIG.USER_AGENT
    );

    await dualLogInfo("✅ DB API request completed successfully");
    await dualLogInfo(
      `📊 Response data received (${JSON.stringify(responseData).length} bytes)`
    );

    return responseData;
  } catch (error: any) {
    await dualLogError("❌ Error making DB API request:", error, {
      jobId,
      expediaId,
      startDate,
      endDate,
    });
    throw error;
  }
}
