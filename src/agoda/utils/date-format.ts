/**
 * Shared date conversion for Agoda URLs/API calls. Accepts the two formats
 * jobs are stored in (`YYYY-MM-DD` or `MM/DD/YYYY`) and converts to the
 * `DD-MM-YYYY` format Agoda's reporting page expects in its query params.
 */
export function convertDateFormat(dateString: string): string {
  let year: string, month: string, day: string;

  if (dateString.includes("/")) {
    // MM/DD/YYYY format (user input) -> DD-MM-YYYY (Agoda)
    const parts = dateString.split("/");
    month = parts[0].padStart(2, "0");
    day = parts[1].padStart(2, "0");
    year = parts[2];
  } else if (dateString.includes("-")) {
    // YYYY-MM-DD format
    const parts = dateString.split("-");
    year = parts[0];
    month = parts[1].padStart(2, "0");
    day = parts[2].padStart(2, "0");
  } else {
    throw new Error(`Unsupported date format: ${dateString}`);
  }

  return `${day}-${month}-${year}`;
}
