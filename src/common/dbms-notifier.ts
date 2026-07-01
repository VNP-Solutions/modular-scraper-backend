import dotenv from "dotenv";

dotenv.config();

/**
 * Notifies the DBMS backend to trigger the post-check lambda after Agoda
 * property verification completes.
 */
export async function triggerDbmsAgodaCheckLambda(): Promise<void> {
  const dbmsBackendUrl = process.env.DBMS_BACKEND_URL;
  if (!dbmsBackendUrl) {
    console.warn(
      "DBMS_BACKEND_URL is not set; skipping Agoda check lambda trigger"
    );
    return;
  }

  const url = `${dbmsBackendUrl}/api/property/agoda-check/trigger-lambda`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(
        `DBMS Agoda check lambda trigger failed (${response.status}):`,
        body
      );
      return;
    }

    console.log("DBMS Agoda check lambda triggered successfully");
  } catch (error) {
    console.error("Failed to trigger DBMS Agoda check lambda:", error);
  }
}
