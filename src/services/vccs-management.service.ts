import fetch from "node-fetch";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { jobService } from "./job.service.js";

export interface VccsUrlParams {
  hotel_id: string;
  ses: string;
  lang: string;
  route: string;
  hotel_account_id?: string;
  res_id?: string;
}

export interface VccsApiResponse {
  data: {
    pagination: {
      current_page_size: number;
      current_page_number: number;
      total_count: number;
      is_last_page: number;
    };
    total_amount: {
      amount_formatted: string;
      currency: string;
      amount: number;
    };
    vccs: Array<{
      hres_id: string;
      booking_legal_entity_name: string;
      current_amount: {
        amount: string;
        currency: string;
        formatted: string;
      };
      expiry_date: string;
    }>;
  };
  params: {
    errors: any[];
    details: any;
  };
  success: number;
}

export interface CardDetailsResponse {
  cardNumber: string;
  expiry: string;
  cvv: string;
  cardholder: string;
  amountToChargeOrRefund: string;
  amountToChargeOrRefundCurrency?: string;
  reasonForCharge?: string;
}

export class VccsManagementService {
  private baseUrl = "https://admin.booking.com";
  private apiBaseUrl = "https://admin.booking.com/fresa/extranet/payments";
  private cardDetailsBaseUrl =
    "https://secure-admin.booking.com/booking_cc_details.html";

  /**
   * Extract URL parameters from the current VCCS management page URL
   */
  extractUrlParams(url: string): VccsUrlParams | null {
    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;

      const hotel_id = params.get("hotel_id");
      const ses = params.get("ses");
      const lang = params.get("lang");
      const route = params.get("route") || "vccs_to_charge"; // Default to vccs_to_charge if not present
      const res_id = params.get("res_id");

      if (!hotel_id || !ses || !lang) {
        dualLogError("Missing required URL parameters", {
          hotel_id,
          ses,
          lang,
          route,
          res_id,
          url,
        });
        return null;
      }

      const urlParams = {
        hotel_id,
        ses,
        lang,
        route,
        res_id: res_id || undefined,
      };

      dualLogInfo("Successfully extracted URL parameters", {
        urlParams,
        originalUrl: url,
      });

      return urlParams;
    } catch (error) {
      dualLogError("Failed to extract URL parameters", { error, url });
      return null;
    }
  }

  /**
   * Get VCCS data from the API using the browser's fetch (avoids fingerprinting detection)
   */
  async getVccsDataFromBrowser(
    page: any,
    params: VccsUrlParams,
    pageNumber: number = 1
  ): Promise<VccsApiResponse | null> {
    try {
      const apiUrl = `${this.apiBaseUrl}/vccs_to_charge`;
      const queryParams = new URLSearchParams({
        ses: params.ses,
        lang: params.lang,
        hotel_id: params.hotel_id,
        hotel_account_id: params.hotel_account_id || "21604744",
        limit: "100",
        page: String(pageNumber),
      });

      const fullUrl = `${apiUrl}?${queryParams.toString()}`;

      dualLogInfo("Making VCCS API request from browser", {
        url: fullUrl,
      });

      // Make the request from inside the browser to avoid fingerprinting
      const result = await page.evaluate(async (url: string) => {
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              accept: "application/json, text/plain, */*",
              "x-requested-with": "XMLHttpRequest",
            },
          } as any); // Type assertion for browser fetch which supports credentials

          if (!response.ok) {
            return {
              success: false,
              status: response.status,
              statusText: response.statusText,
              error: await response.text(),
            };
          }

          const data = await response.json();
          return {
            success: true,
            data,
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
          };
        }
      }, fullUrl);

      if (!result.success) {
        dualLogError("VCCS API request from browser failed", {
          status: result.status,
          statusText: result.statusText,
          url: fullUrl,
          error: result.error,
        });
        return null;
      }

      const data = result.data as VccsApiResponse;
      dualLogInfo("VCCS API response received from browser", {
        success: data.success,
        vccsCount: data.data?.vccs?.length || 0,
        totalAmount: data.data?.total_amount?.amount_formatted,
      });

      return data;
    } catch (error) {
      dualLogError("Failed to get VCCS data from browser", { error, params });
      return null;
    }
  }

  /**
   * Get VCCS data from the API
   */
  async getVccsData(
    params: VccsUrlParams,
    cookies: string,
    headers: Record<string, string> = {},
    effectiveType: string = "4g"
  ): Promise<VccsApiResponse | null> {
    try {
      const apiUrl = `${this.apiBaseUrl}/vccs_to_charge`;
      const queryParams = new URLSearchParams({
        hotel_account_id: params.hotel_account_id || "21604744", // Use extracted or fallback
        hotel_id: params.hotel_id,
        ses: params.ses,
        lang: params.lang,
        limit: "100",
        page: "1",
      });

      const fullUrl = `${apiUrl}?${queryParams.toString()}`;

      // Log all cookies being sent
      // console.log("=== COOKIES BEING SENT TO API ===");
      // console.log("Cookie string length:", cookies.length);
      // console.log("Cookie string:", cookies);
      // console.log("=== END COOKIES ===");

      // Log all headers being sent
      console.log("=== HEADERS BEING SENT TO API ===");
      console.log("Headers:", JSON.stringify(headers, null, 2));
      console.log("=== END HEADERS ===");

      dualLogInfo("Making VCCS API request", {
        url: fullUrl,
        hasCookies: !!cookies,
        cookieLength: cookies.length,
        hasPageviewId: !!headers["x-booking-pageview-id"],
      });

      // Add human-like delay before making API request
      await new Promise((resolve) =>
        setTimeout(resolve, 500 + Math.random() * 1000)
      );

      // Construct the correct referer URL based on whether we have res_id
      const refererUrl = params.res_id
        ? `${this.baseUrl}/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=${params.res_id}&ses=${params.ses}&lang=${params.lang}&hotel_id=${params.hotel_id}`
        : `${this.baseUrl}/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=${params.lang}&ses=${params.ses}&hotel_id=${params.hotel_id}&route=${params.route}`;

      const response = await fetch(fullUrl, {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
          ect: effectiveType,
          priority: "u=1, i",
          referer: refererUrl,
          "sec-ch-ua":
            '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
          "x-booking-language-code": "en-us",
          "x-booking-sitetype-id": "31",
          cookie: cookies,
          ...headers, // Apply custom headers last so they can override defaults
        },
      });

      if (!response.ok) {
        const responseText = await response
          .text()
          .catch(() => "Could not read response");
        dualLogError("VCCS API request failed", {
          status: response.status,
          statusText: response.statusText,
          url: fullUrl,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody: responseText.substring(0, 500), // First 500 chars
        });
        return null;
      }

      const data = (await response.json()) as VccsApiResponse;
      dualLogInfo("VCCS API response received", {
        success: data.success,
        vccsCount: data.data?.vccs?.length || 0,
        totalAmount: data.data?.total_amount?.amount_formatted,
      });

      return data;
    } catch (error) {
      dualLogError("Failed to get VCCS data", { error, params });
      return null;
    }
  }

  /**
   * Get card details by navigating browser (follows authentication redirects)
   */
  async getCardDetailsFromBrowser(
    page: any,
    reservationId: string,
    params: VccsUrlParams,
    scraperInstance?: any, // BookingScraper instance for captcha/2FA handling
    authenticatedUrlPattern?: string // Use authenticated URL pattern from first successful fetch
  ): Promise<CardDetailsResponse | null> {
    try {
      let cardDetailsUrl: string;

      // If we have an authenticated URL pattern from a previous successful fetch, use it!
      // Second and subsequent requests use this URL, which contains the latest session
      // (captured from the final URL after redirect on the first or previous request).
      if (authenticatedUrlPattern) {
        // Replace the bn (booking number) parameter with the new reservation ID
        cardDetailsUrl = authenticatedUrlPattern.replace(
          /bn=[^;]+/,
          `bn=${reservationId}`
        );
        dualLogInfo(
          "Using latest session from previous successful fetch (authenticated URL pattern)",
          {
            reservationId,
            urlPattern: cardDetailsUrl,
          }
        );
      } else {
        // First time - do NOT use session. Booking.com will use cookies, redirect,
        // and set session; we capture the final URL for subsequent requests.
        // Note: Booking.com uses semicolons (;) not ampersands (&) for this URL!
        cardDetailsUrl = `${this.cardDetailsBaseUrl}?lang=${params.lang};bn=${reservationId};hotel_id=${params.hotel_id};has_bvc=1`;
        dualLogInfo(
          "First reservation - constructing URL without session (booking.com will redirect and set session)",
          {
            reservationId,
          }
        );
      }

      dualLogInfo("Navigating to card details page", {
        url: cardDetailsUrl,
        reservationId,
        ...(authenticatedUrlPattern ? { usingAuthenticatedPattern: true } : { firstRequestNoSession: true }),
      });

      // Navigate - Booking.com will automatically:
      // 1. Check authentication cookies
      // 2. Generate new session token
      // 3. Redirect to card details with new session
      // 4. May redirect through /authenticate.html if needed
      const response = await page.goto(cardDetailsUrl, {
        waitUntil: "networkidle2",
        timeout: 60000, // Increased timeout for potential redirects/2FA
      });

      // Get final URL after all redirects
      const finalUrl = page.url();

      dualLogInfo("Landed on page after redirects", {
        reservationId,
        finalUrl,
        statusCode: response?.status(),
        redirected: finalUrl !== cardDetailsUrl,
      });

      // Wait for page to fully render
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if we're on a 2FA/captcha page (your existing detection can handle this)
      const currentPageType = await page.evaluate(() => {
        const pageTitle = document.title.toLowerCase();
        const pageContent = document.body?.innerText?.toLowerCase() || "";

        // Check for auth-assurance page (additional verification after login)
        if (
          window.location.href.includes("auth-assurance") ||
          pageContent.includes("verify your identity")
        ) {
          return "2fa"; // Treat as 2FA since it needs verification
        }
        if (
          pageTitle.includes("verification") ||
          pageContent.includes("verification code")
        ) {
          return "2fa";
        }
        if (
          pageTitle.includes("captcha") ||
          document.querySelector('iframe[src*="captcha"]')
        ) {
          return "captcha";
        }
        if (pageTitle.includes("login") || pageContent.includes("sign in")) {
          return "login";
        }
        if (
          pageTitle.includes("credit card") ||
          document.querySelector('td:contains("Card number")')
        ) {
          return "card_details";
        }
        return "unknown";
      });

      dualLogInfo("Detected page type", {
        reservationId,
        pageType: currentPageType,
        pageTitle: await page.title(),
      });

      // Handle 2FA/captcha/login using existing scraper handlers
      if (
        currentPageType === "2fa" ||
        currentPageType === "captcha" ||
        currentPageType === "login"
      ) {
        dualLogInfo("Authentication challenge detected", {
          reservationId,
          pageType: currentPageType,
          finalUrl,
        });

        if (!scraperInstance) {
          dualLogError(
            "No scraper instance provided to handle authentication",
            {
              reservationId,
              pageType: currentPageType,
            }
          );
          return null;
        }

        // Handle Captcha
        if (currentPageType === "captcha") {
          dualLogInfo("Attempting to solve captcha...", { reservationId });
          const captchaHandled = await scraperInstance.handleCaptcha({
            page,
            type: "automatic", // Try automatic first, falls back to manual
          });

          if (!captchaHandled) {
            dualLogError("Captcha solving failed", { reservationId });
            return null;
          }

          dualLogInfo("Captcha solved successfully", { reservationId });
          // Wait for page to reload after captcha
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        // Handle 2FA
        if (currentPageType === "2fa") {
          dualLogInfo("Attempting to solve 2FA...", { reservationId });
          const twoFAHandled = await scraperInstance.handle2FA({ page });

          if (!twoFAHandled) {
            dualLogError("2FA verification failed", { reservationId });
            return null;
          }

          dualLogInfo("2FA solved successfully", { reservationId });
          // Wait for page to reload after 2FA
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        // Handle Login
        if (currentPageType === "login") {
          dualLogInfo("Login required - attempting to login", {
            reservationId,
          });

          try {
            // Call the scraper's login method with skip already logged check
            await scraperInstance.login(
              scraperInstance.credentials,
              undefined,
              true // skipAlreadyLogged = true to force re-login
            );

            dualLogInfo(
              "Login successful, we should now be on card details page",
              {
                reservationId,
                currentUrl: page.url(),
              }
            );

            // DON'T navigate again! After login/2FA, we're already on the card details page
            // Just wait for card details elements to appear
            let cardDetailsFound = false;
            try {
              // Wait for session input or card table (appears on card details page)
              await page.waitForSelector(
                'input[name="ses"], table.table-condensed',
                {
                  timeout: 15000,
                }
              );
              cardDetailsFound = true;
              dualLogInfo(
                "Card details page elements found after authentication",
                {
                  reservationId,
                  currentUrl: page.url(),
                }
              );
            } catch (waitError) {
              dualLogInfo(
                "Card details elements not found after authentication",
                {
                  reservationId,
                  currentUrl: page.url(),
                  waitError:
                    waitError instanceof Error
                      ? waitError.message
                      : String(waitError),
                }
              );
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (loginError) {
            dualLogError("Login failed during card details flow", {
              reservationId,
              error: loginError,
            });
            return null;
          }
        }

        // After solving captcha/2FA/login, check if we're now on the card details page
        const updatedPageType = await page.evaluate(() => {
          const pageTitle = document.title.toLowerCase();
          const pageContent = document.body?.innerText?.toLowerCase() || "";
          const url = window.location.href;

          // Check for auth-assurance page (additional verification needed)
          if (
            url.includes("auth-assurance") ||
            pageContent.includes("verify your identity")
          ) {
            return "auth-assurance";
          }

          // Check for card details page indicators (multiple ways)
          if (
            pageTitle.includes("credit card") ||
            pageTitle.includes("card details") ||
            url.includes("booking_cc_details") ||
            url.includes("cc_details") ||
            pageContent.includes("card number:") ||
            pageContent.includes("virtual credit card details") ||
            pageContent.includes("expiration date:") ||
            pageContent.includes("cvc code:") ||
            document.querySelector('input[name="ses"]') || // Form with session
            document.querySelector("table.table-condensed") // Card details table
          ) {
            return "card_details";
          }
          return "unknown";
        });

        // If auth-assurance, we need to handle additional verification
        if (updatedPageType === "auth-assurance") {
          dualLogInfo("Auth-assurance page detected, solving verification...", {
            reservationId,
          });
          const twoFAHandled = await scraperInstance.handle2FA({ page });

          if (!twoFAHandled) {
            dualLogError("Auth-assurance verification failed", {
              reservationId,
            });
            return null;
          }

          dualLogInfo("Auth-assurance verification completed", {
            reservationId,
          });

          // Wait for redirect to card details
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Re-check page type
          const finalPageType = await page.evaluate(() => {
            const url = window.location.href;
            const pageContent = document.body?.innerText?.toLowerCase() || "";

            if (
              url.includes("booking_cc_details") ||
              pageContent.includes("card number:") ||
              document.querySelector("table.table-condensed")
            ) {
              return "card_details";
            }
            return "unknown";
          });

          if (finalPageType !== "card_details") {
            dualLogError(
              "Still not on card details page after auth-assurance",
              {
                reservationId,
                currentUrl: page.url(),
              }
            );
            return null;
          }
        } else if (updatedPageType !== "card_details") {
          // Log more details to debug
          const pageInfo = await page.evaluate(() => ({
            title: document.title,
            url: window.location.href,
            bodyText: document.body?.innerText?.substring(0, 500) || "",
            hasSesInput: !!document.querySelector('input[name="ses"]'),
            hasTable: !!document.querySelector("table.table-condensed"),
          }));

          dualLogError(
            "Still not on card details page after solving authentication",
            {
              reservationId,
              currentPageType: updatedPageType,
              currentUrl: page.url(),
              pageInfo,
            }
          );
          return null;
        }

        dualLogInfo(
          "Successfully authenticated and reached card details page",
          {
            reservationId,
          }
        );

        // Extract NEW session from URL or form after authentication
        const newSession = await page.evaluate(() => {
          // Try to get session from URL
          const url = new URL(window.location.href);
          const urlParams = new URLSearchParams(url.search.replace(/;/g, "&"));
          const sesFromUrl = urlParams.get("ses");

          if (sesFromUrl) {
            return sesFromUrl;
          }

          // Try to get session from form hidden input
          const sesInput =
            document.querySelector<HTMLInputElement>('input[name="ses"]');
          if (sesInput && sesInput.value) {
            return sesInput.value;
          }

          return null;
        });

        if (newSession) {
          dualLogInfo("Extracted NEW session after authentication", {
            reservationId,
            newSession,
            oldSession: params.ses,
          });

          // Update params with new session for future requests
          params.ses = newSession;
        } else {
          dualLogInfo(
            "Could not extract new session, continuing with existing",
            {
              reservationId,
            }
          );
        }
      }

      // Get the HTML content
      const html = await page.content();

      // Log a sample of the HTML for debugging
      dualLogInfo("Card details HTML received", {
        reservationId,
        htmlLength: html.length,
        htmlSample: html.substring(0, 500),
        containsCardNumber: html.includes("Card number"),
        containsExpiry: html.includes("Expiration Date"),
        containsCVC: html.includes("CVC"),
      });

      // Check if we actually got to the card details page
      if (!html.includes("Card number") && !html.includes("Virtual card")) {
        dualLogError("Did not reach card details page", {
          reservationId,
          finalUrl,
          pageTitle: await page.title(),
        });
        return null;
      }

      const cardDetails = this.parseCardDetailsFromHtml(html);

      dualLogInfo("Card details extracted from browser", {
        reservationId,
        hasCardNumber: !!cardDetails?.cardNumber,
        hasExpiry: !!cardDetails?.expiry,
        hasCvv: !!cardDetails?.cvv,
        hasCardholder: !!cardDetails?.cardholder,
      });

      // Add the authenticated URL pattern to the response for reuse
      if (cardDetails) {
        const currentUrl = page.url();
        (cardDetails as any).authenticatedUrl = currentUrl;
        dualLogInfo("Saved authenticated URL pattern for subsequent requests", {
          reservationId,
          authenticatedUrl: currentUrl,
        });
      }

      return cardDetails;
    } catch (error) {
      dualLogError("Failed to get card details from browser", {
        error,
        reservationId,
        params,
      });
      return null;
    }
  }

  /**
   * Get card details for a specific reservation ID (legacy Node.js fetch version)
   */
  async getCardDetails(
    reservationId: string,
    params: VccsUrlParams,
    cookies: string,
    headers: Record<string, string> = {},
    effectiveType: string = "4g"
  ): Promise<CardDetailsResponse | null> {
    try {
      const cardDetailsUrl = `${this.cardDetailsBaseUrl}?lang=${params.lang}&bn=${reservationId}&hotel_id=${params.hotel_id}&ses=${params.ses}&has_bvc=1`;

      dualLogInfo("Making card details request", {
        url: cardDetailsUrl,
        reservationId,
      });

      const response = await fetch(cardDetailsUrl, {
        method: "GET",
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
          "cache-control": "max-age=0",
          ect: effectiveType,
          priority: "u=0, i",
          referer: `${this.baseUrl}/`,
          "sec-ch-ua":
            '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-site",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
          cookie: cookies,
          ...headers,
        },
      });

      if (!response.ok) {
        dualLogError("Card details request failed", {
          status: response.status,
          statusText: response.statusText,
          reservationId,
          url: cardDetailsUrl,
        });
        return null;
      }

      const html = await response.text();
      const cardDetails = this.parseCardDetailsFromHtml(html);

      dualLogInfo("Card details extracted", {
        reservationId,
        hasCardNumber: !!cardDetails?.cardNumber,
        hasExpiry: !!cardDetails?.expiry,
        hasCvv: !!cardDetails?.cvv,
        hasCardholder: !!cardDetails?.cardholder,
      });

      return cardDetails;
    } catch (error) {
      dualLogError("Failed to get card details", {
        error,
        reservationId,
        params,
      });
      return null;
    }
  }

  /**
   * Parse card details from HTML response
   */
  private parseCardDetailsFromHtml(html: string): CardDetailsResponse | null {
    try {
      const cardDetails: CardDetailsResponse = {
        cardNumber: "",
        expiry: "",
        cvv: "",
        cardholder: "",
        amountToChargeOrRefund: "",
      };

      // Remove extra whitespace to make parsing more reliable
      const cleanHtml = html.replace(/\s+/g, " ");

      // Extract card number - more flexible regex
      const cardNumberMatch = cleanHtml.match(
        /<td[^>]*>Card number:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
      );
      if (cardNumberMatch) {
        cardDetails.cardNumber = cardNumberMatch[1].trim();
        dualLogInfo("Matched card number", { value: cardDetails.cardNumber });
      } else {
        dualLogInfo("Card number NOT matched in HTML");
      }

      // Extract expiry date - more flexible regex
      const expiryMatch = cleanHtml.match(
        /<td[^>]*>Expiration Date:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
      );
      if (expiryMatch) {
        cardDetails.expiry = expiryMatch[1].trim();
        dualLogInfo("Matched expiry", { value: cardDetails.expiry });
      } else {
        dualLogInfo("Expiry NOT matched in HTML");
      }

      // Extract CVV - more flexible regex
      const cvvMatch = cleanHtml.match(
        /<td[^>]*>CVC Code:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
      );
      if (cvvMatch) {
        cardDetails.cvv = cvvMatch[1].trim();
        dualLogInfo("Matched CVV", { value: cardDetails.cvv });
      } else {
        dualLogInfo("CVV NOT matched in HTML");
      }

      // Extract cardholder name - more flexible regex
      const cardholderMatch = cleanHtml.match(
        /<td[^>]*>Card holder's name:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
      );
      if (cardholderMatch) {
        cardDetails.cardholder = cardholderMatch[1].trim();
        dualLogInfo("Matched cardholder", { value: cardDetails.cardholder });
      } else {
        dualLogInfo("Cardholder NOT matched in HTML");
      }

      const extractCurrency = (value: string): string | null => {
        const codeMatch = value.match(/\b([A-Z]{3})\b/);
        if (codeMatch) return codeMatch[1];

        const symbolMatch = value.match(/^([^\d\s-]+)/);
        return symbolMatch?.[1]?.trim() || null;
      };

      // Extract available balance from table structure
      const balanceMatch = cleanHtml.match(
        /<td[^>]*class="sp"[^>]*>Available balance:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
      );
      if (balanceMatch) {
        cardDetails.amountToChargeOrRefund = balanceMatch[1].trim();
        const currency = extractCurrency(cardDetails.amountToChargeOrRefund);
        if (currency) {
          cardDetails.amountToChargeOrRefundCurrency = currency;
        }
        dualLogInfo("Matched available balance", {
          value: cardDetails.amountToChargeOrRefund,
          currency: cardDetails.amountToChargeOrRefundCurrency,
        });
      } else {
        dualLogInfo("Available balance NOT matched in HTML");
      }

      // Alternative: Extract from status message "You can charge this card <span>US$163.28</span>"
      if (!cardDetails.amountToChargeOrRefund) {
        const chargeAmountMatch = cleanHtml.match(
          /You can charge this card\s*<span>([^<]+)<\/span>/i
        );
        if (chargeAmountMatch) {
          cardDetails.amountToChargeOrRefund = chargeAmountMatch[1].trim();
          const currency = extractCurrency(cardDetails.amountToChargeOrRefund);
          if (currency) {
            cardDetails.amountToChargeOrRefundCurrency = currency;
          }
          dualLogInfo("Matched charge amount from message", {
            value: cardDetails.amountToChargeOrRefund,
            currency: cardDetails.amountToChargeOrRefundCurrency,
          });
        }
      }

      // Extract card type for additional context
      const cardTypeMatch = cleanHtml.match(
        /<td[^>]*class="sp"[^>]*>Card type:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
      );
      if (cardTypeMatch) {
        // Store card type in reason_for_charge field
        cardDetails.reasonForCharge = cardTypeMatch[1].trim();
        dualLogInfo("Matched card type", {
          value: cardDetails.reasonForCharge,
        });
      }

      dualLogInfo("Parsed card details from HTML", {
        hasCardNumber: !!cardDetails.cardNumber,
        hasExpiry: !!cardDetails.expiry,
        hasCvv: !!cardDetails.cvv,
        hasCardholder: !!cardDetails.cardholder,
        hasAmount: !!cardDetails.amountToChargeOrRefund,
        cardType: cardDetails.reasonForCharge,
      });

      return cardDetails;
    } catch (error) {
      dualLogError("Failed to parse card details from HTML", { error });
      return null;
    }
  }

  /**
   * Process all VCCS reservations and get card details (browser-based)
   */
  async processAllVccsReservationsFromBrowser(
    page: any,
    vccsData: VccsApiResponse,
    params: VccsUrlParams,
    jobId?: string,
    propertyIdForDb?: string, // MongoDB ObjectId (NOT hotel_id!)
    scraperInstance?: any // BookingScraper instance for auth handling
  ): Promise<{
    processed: number;
    errors: number;
    skippedResume: number;
    results: Array<{
      reservationId: string;
      vccsData: any;
      cardDetails: CardDetailsResponse | null;
      saved: boolean;
      resumeSkipped?: boolean;
    }>;
  }> {
    const results: Array<{
      reservationId: string;
      vccsData: any;
      cardDetails: CardDetailsResponse | null;
      saved: boolean;
      resumeSkipped?: boolean;
    }> = [];

    let processed = 0;
    let errors = 0;
    let skippedResume = 0;
    let latestAuthenticatedUrl: string | undefined = undefined; // Store LATEST authenticated URL (updated after EVERY successful fetch)

    const completedReservationIds = jobId
      ? new Set(
          await jobService.getReservationIdsWithCompleteCardForJob(jobId)
        )
      : new Set<string>();

    dualLogInfo("Starting VCCS reservation processing", {
      totalVccs: vccsData.data.vccs.length,
      jobId,
      propertyIdForDb,
      resumeSkipCount: completedReservationIds.size,
    });

    for (const vccs of vccsData.data.vccs) {
      const resId = String(vccs.hres_id);
      if (completedReservationIds.has(resId)) {
        skippedResume++;
        dualLogInfo(
          `Skipping reservation ${resId} (card already stored for this job)`
        );
        results.push({
          reservationId: resId,
          vccsData: vccs,
          cardDetails: null,
          saved: true,
          resumeSkipped: true,
        });
        continue;
      }

      try {
        dualLogInfo(`Processing reservation ${vccs.hres_id}`);

        // Get card details for this reservation using browser navigation
        // Use LATEST authenticated URL from previous fetch (if available)
        const cardDetails = await this.getCardDetailsFromBrowser(
          page,
          vccs.hres_id,
          params,
          scraperInstance, // Pass scraper instance for auth handling
          latestAuthenticatedUrl // Use LATEST authenticated URL
        );

        // ALWAYS update the latest authenticated URL after EVERY successful fetch
        // This is important because 2FA/captcha can happen at any time and change the session
        if (cardDetails && (cardDetails as any).authenticatedUrl) {
          latestAuthenticatedUrl = (cardDetails as any).authenticatedUrl;
          dualLogInfo(`Updated latest authenticated URL for next reservation`, {
            reservationId: vccs.hres_id,
            latestAuthenticatedUrl,
          });
        }

        let saved = false;

        // Save to database if jobId and propertyIdForDb are provided
        if (jobId && propertyIdForDb && cardDetails) {
          try {
            const jobItemData = await this.createJobItemData(
              vccs,
              cardDetails,
              jobId,
              propertyIdForDb
            );

            // Check if reservation already exists
            const existingReservation =
              await jobService.findJobItemByReservationId(jobId, vccs.hres_id);

            if (existingReservation) {
              const updatedItem = await jobService.updateJobItem(
                existingReservation._id.toString(),
                jobItemData
              );
              dualLogInfo(`Updated reservation ${vccs.hres_id} with new data`);
              saved = true;
            } else {
              const savedItem = await jobService.createJobItem(jobItemData);
              dualLogInfo(`Saved reservation ${vccs.hres_id} to database`);
              saved = true;
            }
          } catch (saveError) {
            dualLogError(
              `Failed to save reservation ${vccs.hres_id} to database`,
              {
                error: saveError,
                reservationId: vccs.hres_id,
              }
            );
          }
        }

        results.push({
          reservationId: vccs.hres_id,
          vccsData: vccs,
          cardDetails,
          saved,
        });

        processed++;
        dualLogInfo(
          `Successfully processed reservation ${vccs.hres_id} (${processed}/${vccsData.data.vccs.length})`
        );

        // Add a small delay between requests to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        errors++;
        dualLogError(`Error processing reservation ${vccs.hres_id}`, {
          error,
          reservationId: vccs.hres_id,
        });

        results.push({
          reservationId: vccs.hres_id,
          vccsData: vccs,
          cardDetails: null,
          saved: false,
        });
      }
    }

    dualLogInfo("VCCS reservation processing completed", {
      processed,
      errors,
      skippedResume,
      total: vccsData.data.vccs.length,
    });

    return {
      processed,
      errors,
      skippedResume,
      results,
    };
  }

  /**
   * Process all VCCS reservations and get card details (legacy version)
   */
  async processAllVccsReservations(
    vccsData: VccsApiResponse,
    params: VccsUrlParams,
    cookies: string,
    headers: Record<string, string> = {},
    jobId?: string,
    propertyId?: string,
    effectiveType: string = "4g"
  ): Promise<{
    processed: number;
    errors: number;
    skippedResume: number;
    results: Array<{
      reservationId: string;
      vccsData: any;
      cardDetails: CardDetailsResponse | null;
      saved: boolean;
      resumeSkipped?: boolean;
    }>;
  }> {
    const results: Array<{
      reservationId: string;
      vccsData: any;
      cardDetails: CardDetailsResponse | null;
      saved: boolean;
      resumeSkipped?: boolean;
    }> = [];

    let processed = 0;
    let errors = 0;
    let skippedResume = 0;

    const completedReservationIds = jobId
      ? new Set(
          await jobService.getReservationIdsWithCompleteCardForJob(jobId)
        )
      : new Set<string>();

    dualLogInfo("Starting VCCS reservation processing", {
      totalVccs: vccsData.data.vccs.length,
      jobId,
      propertyId,
      resumeSkipCount: completedReservationIds.size,
    });

    for (const vccs of vccsData.data.vccs) {
      const resId = String(vccs.hres_id);
      if (completedReservationIds.has(resId)) {
        skippedResume++;
        dualLogInfo(
          `Skipping reservation ${resId} (card already stored for this job)`
        );
        results.push({
          reservationId: resId,
          vccsData: vccs,
          cardDetails: null,
          saved: true,
          resumeSkipped: true,
        });
        continue;
      }

      try {
        dualLogInfo(`Processing reservation ${vccs.hres_id}`);

        // Get card details for this reservation
        const cardDetails = await this.getCardDetails(
          vccs.hres_id,
          params,
          cookies,
          headers,
          effectiveType
        );

        let saved = false;

        // Save to database if jobId and propertyId are provided
        if (jobId && propertyId && cardDetails) {
          try {
            const jobItemData = await this.createJobItemData(
              vccs,
              cardDetails,
              jobId,
              propertyId
            );

            // Check if reservation already exists
            const existingReservation =
              await jobService.findJobItemByReservationId(jobId, vccs.hres_id);

            if (existingReservation) {
              const updatedItem = await jobService.updateJobItem(
                existingReservation._id.toString(),
                jobItemData
              );
              dualLogInfo(`Updated reservation ${vccs.hres_id} with new data`);
              saved = true;
            } else {
              const savedItem = await jobService.createJobItem(jobItemData);
              dualLogInfo(`Saved reservation ${vccs.hres_id} to database`);
              saved = true;
            }
          } catch (saveError) {
            dualLogError(
              `Failed to save reservation ${vccs.hres_id} to database`,
              {
                error: saveError,
                reservationId: vccs.hres_id,
              }
            );
          }
        }

        results.push({
          reservationId: vccs.hres_id,
          vccsData: vccs,
          cardDetails,
          saved,
        });

        processed++;
        dualLogInfo(
          `Successfully processed reservation ${vccs.hres_id} (${processed}/${vccsData.data.vccs.length})`
        );

        // Add a small delay between requests to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        errors++;
        dualLogError(`Error processing reservation ${vccs.hres_id}`, {
          error,
          reservationId: vccs.hres_id,
        });

        results.push({
          reservationId: vccs.hres_id,
          vccsData: vccs,
          cardDetails: null,
          saved: false,
        });
      }
    }

    dualLogInfo("VCCS reservation processing completed", {
      processed,
      errors,
      skippedResume,
      total: vccsData.data.vccs.length,
    });

    return {
      processed,
      errors,
      skippedResume,
      results,
    };
  }

  /**
   * Create job item data from VCCS and card details
   */
  private async createJobItemData(
    vccs: any,
    cardDetails: CardDetailsResponse,
    jobId: string,
    propertyIdForDb: string // MongoDB ObjectId (NOT hotel_id!)
  ): Promise<any> {
    // Parse amount
    const parseAmount = (amountStr: string): number => {
      if (!amountStr) return 0;
      const cleaned = amountStr.replace(/[^\d.-]/g, "");
      const amount = parseFloat(cleaned);
      return isNaN(amount) ? 0 : Math.abs(amount);
    };

    const jobItemData = {
      job_id: jobId,
      property_id: propertyIdForDb,
      guest_name: "VCCS Guest", // This might need to be extracted from somewhere else
      reservation_id: vccs.hres_id,
      confirmation_number: vccs.hres_id, // Use reservation ID as confirmation number
      check_in_date: new Date(), // These dates might need to be extracted from VCCS data
      check_out_date: new Date(),
      room_type: "VCCS Reservation",
      booking_amount: parseAmount(vccs.current_amount.amount),
      booked_date: new Date(),
      has_card_info: !!cardDetails.cardNumber,
      has_payment_info: !!vccs.current_amount.amount,
      payment_info: {
        total_guest_payment: parseAmount(vccs.current_amount.amount),
        total_payout: parseAmount(vccs.current_amount.amount),
        amount_to_charge_or_refund: parseAmount(
          cardDetails.amountToChargeOrRefund
        ),
        amount_to_charge_or_refund_currency:
          cardDetails.amountToChargeOrRefundCurrency ||
          vccs.current_amount.currency ||
          "",
        cancellation_fee: 0,
        charge_before: vccs.expiry_date,
      },
      card_info: {
        expiry_date: cardDetails.expiry,
        card_number: cardDetails.cardNumber,
        cvv: cardDetails.cvv,
        card_holder_name: cardDetails.cardholder,
        reason_for_charge: cardDetails.reasonForCharge,
      },
      reservation_status: "VCCS Active",
    };

    return jobItemData;
  }

  /**
   * Extract cookies and headers from browser page
   */
  async extractCookiesAndHeaders(page: any): Promise<{
    cookies: string;
    headers: Record<string, string>;
    hotel_account_id?: string;
    effectiveType: string;
  }> {
    try {
      console.log("=== STARTING COOKIE/HEADER EXTRACTION ===");

      // Wait for page to load naturally like a human would (Puppeteer method)
      console.log("Waiting for page to load...");
      await page.waitForSelector("body", { timeout: 10000 });
      console.log("Page loaded successfully");

      // Simulate human-like behavior
      console.log("Adding human-like delay...");
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 2000)
      );
      // console.log("Human-like delay completed");

      // Simulate mouse movement to look more human (Puppeteer method)
      try {
        console.log("Simulating mouse movement...");
        await page.mouse.move(
          100 + Math.random() * 200,
          100 + Math.random() * 200
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 200 + Math.random() * 500)
        );
        console.log("Mouse movement completed");
      } catch (error) {
        console.log("Mouse movement failed (ignoring):", error);
        // Ignore mouse movement errors
      }

      // Get cookies from the page
      console.log("Getting cookies from page...");
      const cookies = await page.cookies();
      console.log("Cookies retrieved successfully, count:", cookies.length);

      const cookieString = cookies
        .map((cookie: any) => `${cookie.name}=${cookie.value}`)
        .join("; ");

      // Log extracted cookies
      console.log("=== EXTRACTED COOKIES FROM PAGE ===");
      console.log("Total cookies found:", cookies.length);
      console.log(
        "Cookie names:",
        cookies.map((c: any) => c.name)
      );
      // console.log("Cookie string:", cookieString);
      // console.log("=== END EXTRACTED COOKIES ===");

      // Extract headers from the page
      const headers: Record<string, string> = {};
      let pageData: any = {};

      // Try to get headers from the page
      try {
        pageData = await page.evaluate(() => {
          try {
            const result: any = {};

            // Debug: Log some page info
            result.pageTitle = document.title;
            result.scriptCount = document.querySelectorAll("script").length;
            result.hasBookingGlobal =
              typeof (window as any).booking !== "undefined";

            // Note: CSRF token is not required for this API endpoint

            // Try to get pageview ID from script - multiple patterns
            const pageviewMatch = document.documentElement.innerHTML.match(
              /booking\.PAGEVIEW_ID = "([^"]+)"/
            );
            if (pageviewMatch) {
              result.pageviewId = pageviewMatch[1];
            }

            // Alternative pageview ID extraction from $u object
            if (!result.pageviewId) {
              const pageviewMatch2 = document.documentElement.innerHTML.match(
                /"PAGEVIEW_ID":"([^"]+)"/
              );
              if (pageviewMatch2) {
                result.pageviewId = pageviewMatch2[1];
              }
            }

            // Try to extract hotel_account_id (user_id) from the $u object
            const userMatch =
              document.documentElement.innerHTML.match(/"user_id":\s*(\d+)/);
            if (userMatch) {
              result.hotelAccountId = userMatch[1];
            }

            // Alternative extraction from js_data
            if (!result.hotelAccountId) {
              const userMatch2 =
                document.documentElement.innerHTML.match(/"user_id":(\d+)/);
              if (userMatch2) {
                result.hotelAccountId = userMatch2[1];
              }
            }

            // Try to extract CSRF token from meta tag
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            if (csrfMeta) {
              result.csrfToken = csrfMeta.getAttribute("content");
            }

            // Try to extract CSRF token from script variables
            if (!result.csrfToken) {
              const csrfMatch = document.documentElement.innerHTML.match(
                /var\s+token\s*=\s*["']([^"']+)["']/
              );
              if (csrfMatch) {
                result.csrfToken = csrfMatch[1];
              }
            }

            // Alternative CSRF extraction from window object
            if (!result.csrfToken) {
              const csrfMatch2 = document.documentElement.innerHTML.match(
                /window\.csrfToken\s*=\s*["']([^"']+)["']/
              );
              if (csrfMatch2) {
                result.csrfToken = csrfMatch2[1];
              }
            }

            // Try to get CSRF token from global variable
            if (!result.csrfToken && typeof window !== "undefined") {
              try {
                if ((window as any).csrfToken) {
                  result.csrfToken = (window as any).csrfToken;
                }
              } catch (e) {
                // Ignore errors
              }
            }

            // Another alternative pattern
            if (!result.pageviewId) {
              const pageviewMatch3 = document.documentElement.innerHTML.match(
                /PAGEVIEW_ID = "([^"]+)"/
              );
              if (pageviewMatch3) {
                result.pageviewId = pageviewMatch3[1];
              }
            }

            // Try to get req_info element content
            const reqInfo = document.getElementById("req_info");
            if (reqInfo) {
              result.reqInfo = reqInfo.innerHTML;
            }

            // Evaluate x-booking-client-info function
            try {
              result.vnExists = typeof (window as any).vn !== "undefined";
              result.vnAExists = typeof (window as any).vn?.a !== "undefined";
              result.vnATrackedExists =
                typeof (window as any).vn?.a?.tracked !== "undefined";

              if (
                typeof (window as any).vn !== "undefined" &&
                (window as any).vn?.a?.tracked
              ) {
                const vnTracked = (window as any).vn.a.tracked();
                result.vnTrackedResult = vnTracked;
                result.vnTrackedType = typeof vnTracked;

                if (vnTracked !== undefined && vnTracked !== null) {
                  // If it's an object, stringify it; otherwise use as-is
                  result.bookingClientInfo =
                    typeof vnTracked === "object"
                      ? JSON.stringify(vnTracked)
                      : String(vnTracked);
                }
              }
            } catch (e: any) {
              result.vnTrackingError = e.message;
            }

            // Try to get ECT (Effective Connection Type) from navigator
            const navConnection = (navigator as any).connection;
            if (navConnection && navConnection.effectiveType) {
              result.effectiveType = navConnection.effectiveType;
            } else if (navConnection && navConnection.type) {
              result.effectiveType = navConnection.type;
            } else {
              // Fallback to default
              result.effectiveType = "4g";
            }

            return result;
          } catch (error: any) {
            return { error: error.message };
          }
        });

        // Check if page evaluation had an error
        if (pageData.error) {
          dualLogError("Page evaluation error", { error: pageData.error });
        } else {
          if (pageData.pageviewId) {
            headers["x-booking-pageview-id"] = pageData.pageviewId;
          }

          // Set x-booking-info to the actual evaluated value (not the function string)
          if (pageData.reqInfo) {
            headers["x-booking-info"] = pageData.reqInfo;
          }

          // Set x-booking-client-info to the actual evaluated value
          // If evaluation failed, send function string as fallback (header must be present)
          if (pageData.bookingClientInfo) {
            headers["x-booking-client-info"] = pageData.bookingClientInfo;
          } else {
            // Send function string as fallback - matches working curl command
            headers["x-booking-client-info"] =
              "function(){return vn.a.tracked&&vn.a.tracked()}";
          }

          // Add CSRF token if available
          if (pageData.csrfToken) {
            headers["x-booking-csrf"] = pageData.csrfToken;
          }

          // Add all the standard browser headers that your working curl has
          headers["accept"] = "application/json, text/plain, */*";
          headers["accept-language"] = "en-GB,en-US;q=0.9,en;q=0.8";
          headers["ect"] = pageData.effectiveType || "4g";
          headers["priority"] = "u=1, i";
          // Extract current page URL for referer
          const currentUrl = await page.url();
          headers["referer"] = currentUrl;
          headers["sec-ch-ua"] =
            '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';
          headers["sec-ch-ua-mobile"] = "?0";
          headers["sec-ch-ua-platform"] = '"macOS"';
          headers["sec-fetch-dest"] = "empty";
          headers["sec-fetch-mode"] = "cors";
          headers["sec-fetch-site"] = "same-origin";
          headers["user-agent"] =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
          headers["x-booking-language-code"] = "en-us";
          headers["x-booking-sitetype-id"] = "31";

          // Log extracted page data for debugging
          dualLogInfo("Extracted page data", {
            pageTitle: pageData.pageTitle,
            scriptCount: pageData.scriptCount,
            hasBookingGlobal: pageData.hasBookingGlobal,
            hasPageviewId: !!pageData.pageviewId,
            hasReqInfo: !!pageData.reqInfo,
            hasBookingClientInfo: !!pageData.bookingClientInfo,
            hotelAccountId: pageData.hotelAccountId,
            csrfToken: pageData.csrfToken,
            effectiveType: pageData.effectiveType,
            reqInfoLength: pageData.reqInfo?.length || 0,
            bookingClientInfoType: typeof pageData.bookingClientInfo,
            // Debug info for vn.a.tracked
            vnExists: pageData.vnExists,
            vnAExists: pageData.vnAExists,
            vnATrackedExists: pageData.vnATrackedExists,
            vnTrackedType: pageData.vnTrackedType,
            vnTrackingError: pageData.vnTrackingError,
          });
        }
      } catch (error) {
        dualLogInfo("Could not extract headers from page", { error });
      }

      dualLogInfo("Extracted cookies and headers", {
        cookieCount: cookies.length,
        hasPageviewId: !!headers["x-booking-pageview-id"],
        hasReqInfo: !!headers["x-booking-info"],
        hasClientInfo: !!headers["x-booking-client-info"],
        hasCsrfToken: !!headers["x-booking-csrf"],
        pageviewId: headers["x-booking-pageview-id"] || "none",
        hotelAccountId: pageData.hotelAccountId || "none",
        effectiveType: pageData.effectiveType || "none",
        cookieNames: cookies.map((c: any) => c.name).slice(0, 10), // Show first 10 cookie names
      });

      return {
        cookies: cookieString,
        headers,
        hotel_account_id: pageData.hotelAccountId,
        effectiveType: pageData.effectiveType || "4g",
      };
    } catch (error) {
      dualLogError("Failed to extract cookies and headers", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        cookies: "",
        headers: {},
        hotel_account_id: undefined,
        effectiveType: "4g",
      };
    }
  }
}

export const vccsManagementService = new VccsManagementService();
