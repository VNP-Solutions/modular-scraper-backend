import dotenv from "dotenv";

dotenv.config();

/**
 * After a property check finishes, ask the DBMS backend to re-trigger its
 * Expedia-check Lambda so the next queued account-group payload (if any) gets
 * processed. The DBMS owns the Lambda + queue config; we just notify it.
 *
 * Non-blocking by design: any failure is logged and swallowed so it never
 * affects the check that just completed.
 */
export async function triggerDbmsExpediaCheckLambda(): Promise<void> {
  const dbmsBackendUrl = process.env.DBMS_BACKEND_URL;
  if (!dbmsBackendUrl) {
    console.log(
      "DBMS_BACKEND_URL not configured, skipping DBMS Lambda trigger"
    );
    return;
  }

  const url = `${dbmsBackendUrl}/api/property/expedia-check/trigger-lambda`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (response.ok) {
      console.log("DBMS Expedia-check Lambda re-triggered successfully");
    } else {
      console.error(`DBMS Lambda trigger failed: ${response.status}`);
    }
  } catch (error) {
    console.error("Error triggering DBMS Lambda:", error);
  } finally {
    clearTimeout(timeout);
  }
}
