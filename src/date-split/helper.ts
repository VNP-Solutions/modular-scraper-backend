import dotenv from "dotenv";

dotenv.config();

export function splitDateRangeIntoChunks(
  start_date: string,
  end_date: string,
  chunkSize: number
) {
  // Debug: Log the environment variable and parsed chunk size
  console.log("🔍 Debug Info:");
  console.log("Raw CHUNK_SIZE from env:", process.env.CHUNK_SIZE);
  console.log("Parsed chunkSize:", chunkSize);

  // Parse dates correctly regardless of MM/DD/YYYY or DD/MM/YYYY format
  const parseDate = (dateStr: string) => {
    // Check if the date is in MM/DD/YYYY format (our internal format)
    if (dateStr.includes("/")) {
      const parts = dateStr.split("/");
      // Validate that we have three parts (month, day, year)
      if (
        parts[0].length <= 2 &&
        parts[1].length <= 2 &&
        parts[2].length === 4
      ) {
        // We consistently use MM/DD/YYYY format internally
        // The first part is month, second part is day
        const month = parseInt(parts[0], 10);
        const day = parseInt(parts[1], 10);
        const year = parseInt(parts[2], 10);

        // Create date using reliable YYYY-MM-DD format
        return new Date(
          `${year}-${month.toString().padStart(2, "0")}-${day
            .toString()
            .padStart(2, "0")}`
        );
      }
    }

    // Fallback to default parsing
    return new Date(dateStr);
  };

  // Parse the start and end dates
  const startDate = parseDate(start_date);
  const endDate = parseDate(end_date);

  // Log the parsed dates for debugging
  console.log(`Parsed start date: ${startDate.toISOString()}`);
  console.log(`Parsed end date: ${endDate.toISOString()}`);

  // If start and end dates are the same, return a single chunk with same dates
  if (startDate.getTime() === endDate.getTime()) {
    return [
      {
        start: start_date,
        end: end_date,
      },
    ];
  }

  const dateChunks = [];
  let currentDate = new Date(startDate);

  // Only create chunks for the specific date range requested
  while (currentDate <= endDate) {
    const nextDate = new Date(currentDate);
    nextDate.setDate(currentDate.getDate() + chunkSize - 1);
    if (nextDate > endDate) {
      nextDate.setTime(endDate.getTime()); // Use exact end date time
    }

    // Format dates as MM/DD/YYYY for internal consistency
    const formatDate = (date: Date) => {
      const month = date.getMonth() + 1;
      const day = date.getDate();
      const year = date.getFullYear();
      return `${month}/${day}/${year}`;
    };

    dateChunks.push({
      start: formatDate(currentDate),
      end: formatDate(nextDate),
    });

    // Move to next chunk
    currentDate = new Date(nextDate);
    currentDate.setDate(currentDate.getDate() + 1);
  }

  console.log("📊 Final chunks:", dateChunks);
  return dateChunks;
}

export const formatDateForProcessing = (dateStr: string) => {
  // Input is in MM/DD/YYYY format (our internal format)
  const [month, day, year] = dateStr.split("/");
  // Parse date using reliable YYYY-MM-DD format
  const date = new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  );
  const formattedDay = date.getDate().toString().padStart(2, "0");
  const formattedMonth = (date.getMonth() + 1).toString().padStart(2, "0");
  const formattedYear = date.getFullYear();
  // Return in DD/MM/YYYY format as expected by Expedia's interface
  return `${formattedDay}/${formattedMonth}/${formattedYear}`;
};

export const formatDateForUrl = (dateStr: string) => {
  // Convert MM/DD/YYYY to a format JavaScript can parse correctly
  const [month, day, year] = dateStr.split("/");
  const date = new Date(`${year}-${month}-${day}`);
  const formattedYear = date.getFullYear();
  const formattedMonth = (date.getMonth() + 1).toString().padStart(2, "0");
  const formattedDay = date.getDate().toString().padStart(2, "0");
  return `${formattedYear}-${formattedMonth}-${formattedDay}`;
};
