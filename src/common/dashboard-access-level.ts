import dotenv from "dotenv";
import type { OtaPlatform } from "./ota-verification-patch.js";

dotenv.config();

/**
 * Mirrors an OTA access-level verdict to the dashboard backend, which keeps its
 * own copy of the flag on the property's child document.
 */
export async function patchDashboardAccessLevel(
  platform: OtaPlatform,
  propertyId: string,
  accessLevel: boolean
): Promise<void> {
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (!dashboardUrl) {
    console.warn(
      "DASHBOARD_URL is not set; skipping dashboard access-level update"
    );
    return;
  }

  const url = `${dashboardUrl.replace(/\/+$/, "")}/api/property/${propertyId}/access-level`;
  const field = `${platform}_access_level`;

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: accessLevel }),
    });

    const body = await response.text().catch(() => "");

    if (!response.ok) {
      console.error(
        `Dashboard access-level update failed for property ${propertyId} (${response.status}):`,
        body
      );
      return;
    }

    console.log(
      `Dashboard access-level updated for property ${propertyId} (${field}=${accessLevel}):`,
      body
    );
  } catch (error) {
    console.error(
      `Failed to update dashboard access level for property ${propertyId}:`,
      error
    );
  }
}
