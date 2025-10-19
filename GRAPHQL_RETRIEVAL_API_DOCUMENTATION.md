# GraphQL Retrieval API Documentation

## Overview

The **GraphQL Retrieval API** (`/api/expedia/graphql-retrieval-run-job`) is a new endpoint that enables GraphQL-based scraping of reservation data from Expedia Partner Central. Unlike the traditional DOM-based retrieval API, this endpoint uses GraphQL queries to fetch reservation data, making it faster and more efficient.

## Key Features

- **GraphQL-Based Scraping**: Uses Expedia's GraphQL API instead of DOM scraping
- **Reservation-Specific Queries**: Queries each reservation by its ID using the `searchParam` parameter
- **Human-Like Behavior**: Implements random delays (2-5 seconds) between reservation queries
- **EVC Card Data Fetching**: Automatically retrieves virtual card details with retry logic
- **RetrievalItem Storage**: Stores scraped data in the dedicated `RetrievalItem` collection
- **Automatic Status Updates**: Updates Retrieval status (Running → Completed/Failed)
- **Error Resilience**: Continues processing even if individual reservations fail

## API Endpoint

```
POST /api/expedia/graphql-retrieval-run-job
```

### Request Body

```json
{
  "retrieval_id": "68f4ce37d621740b157f49e1"
}
```

### Response (Success)

```json
{
  "status": 200,
  "message": "GraphQL retrieval search completed successfully",
  "retrieval_id": "68f4ce37d621740b157f49e1",
  "jobId": "graphql_retrieval_job_68f4ce37d621740b157f49e1_1760882087236",
  "reservationCount": 2,
  "processedCount": 2
}
```

### Response (Error)

```json
{
  "status": 400,
  "message": "retrieval_id is required"
}
```

## How It Works

### 1. Request Validation

- Validates that `retrieval_id` is provided
- Retrieves `Retrieval` document from database
- Extracts `reservations` array (list of reservation IDs)
- Fetches Expedia credentials from `PropertyCredentials` (with password decryption)

### 2. Worker Job Creation

The API creates a worker job with:

- **jobType**: `"graphql-retrieval-run"`
- **jobId**: Auto-generated (e.g., `graphql_retrieval_job_<retrieval_id>_<timestamp>`)
- **retrievalId**: The retrieval ObjectId
- **expediaId**: Property's Expedia ID
- **reservations**: Array of reservation IDs formatted as `[{ id: expediaId, idList: [reservation_ids] }]`
- **user_email**: Decrypted Expedia username
- **user_password**: Decrypted Expedia password

### 3. Worker Processing (`handleGraphqlRetrievalRun`)

The worker:

1. Extracts reservation IDs from the formatted reservations array
2. Initializes job logging
3. Sets scraping state to "running"
4. Calls `graphqlRetrievalScraping()` function

### 4. GraphQL Retrieval Scraping (`graphqlRetrievalScraping`)

The main scraping function:

1. **Browser Setup**:

   - Launches browser (local or production via Browserless)
   - Navigates to Expedia login page

2. **Authentication**:

   - Performs login with provided credentials
   - Handles OTP verification (via Gmail API)

3. **Cookie Extraction**:

   - Extracts session cookies for API authentication
   - Formats cookies as header string

4. **Reservation Processing** (for each reservation ID):

   - Adds human-like delay (2-5 seconds random)
   - Makes GraphQL query with `searchParam` set to specific reservation ID
   - Processes GraphQL response
   - Fetches EVC card data if available (with 4-second rate limiting delay)
   - Maps card data to `CardInfo` format
   - Extracts payment information
   - Saves to `RetrievalItem` database

5. **Cleanup**:
   - Closes browser
   - Updates retrieval status
   - Finalizes logging

### 5. GraphQL Query Structure

The API makes a GraphQL query to:

```
https://api.expediapartnercentral.com/supply/experience/gateway/graphql
```

With the following key parameters:

```graphql
reservationSearchV2(input: {
  propertyId: <expediaId>,
  searchParam: "<reservationId>",
  dateType: "checkIn",
  evc: false,
  expediaCollect: true,
  hotelCollect: true,
  ...
})
```

**Note**: The `searchParam` is set to the specific reservation ID being queried.

### 6. EVC Card Data Fetching

For each reservation with `evcCardDetailsExist: true`:

- Calls EVC API: `https://apps.expediapartnercentral.com/lodging/bookings/evc/getEVCCardDataByCardResourceId`
- Implements rate limiting (4-second base delay)
- Retry logic with exponential backoff (up to 8 retries)
- Handles 429 (rate limit) responses with extended delays

### 7. Data Storage

Data is saved to the `RetrievalItem` collection with:

```typescript
{
  retrieval_id: ObjectId,
  parent_retrieval_id: ObjectId,
  property_id: ObjectId,
  guest_name: string,
  reservation_id: string,
  confirmation_number: string,
  check_in_date: Date,
  check_out_date: Date,
  room_type: string,
  booking_amount: number,
  booked_date: Date,
  has_card_info: boolean,
  card_info: {
    card_number: string,
    expiry_date: string,
    cvv: string,
    reason_for_charge: string
  },
  has_payment_info: boolean,
  payment_info: {
    total_guest_payment: number,
    total_payout: number,
    amount_to_charge_or_refund: number
  },
  reservation_status: string,
  additional_text: string
}
```

## Files Created/Modified

### New Files Created:

1. **`src/expedia-graphql-retrieval.ts`**
   - Main GraphQL retrieval scraping logic
   - Functions:
     - `graphqlRetrievalScraping()` - Main entry point
     - `makeGraphQLRequestForReservation()` - Makes GraphQL query for specific reservation
     - `fetchEVCCardData()` - Fetches EVC card details with retry logic
     - `saveGraphQLReservationToRetrievalItem()` - Saves data to database

### Modified Files:

1. **`src/common/worker-types.ts`**

   - Added `"graphql-retrieval-run"` to `jobType` enum

2. **`src/workers/scraping-worker.ts`**

   - Added import for `graphqlRetrievalScraping`
   - Added case statement for `"graphql-retrieval-run"`
   - Implemented `handleGraphqlRetrievalRun()` method

3. **`src/app/app.ts`**
   - Added new POST endpoint `/api/expedia/graphql-retrieval-run-job`
   - Includes Swagger documentation

## Differences from Traditional Retrieval API

| Feature             | Traditional (`retrieval-run-job`)         | GraphQL (`graphql-retrieval-run-job`)    |
| ------------------- | ----------------------------------------- | ---------------------------------------- |
| **Scraping Method** | DOM scraping via Puppeteer                | GraphQL API queries                      |
| **Speed**           | Slower (page loads, clicks)               | Faster (direct API calls)                |
| **Data Source**     | HTML DOM elements                         | Structured JSON responses                |
| **Navigation**      | Navigates to property → reservations page | Directly queries API after login         |
| **Rate Limiting**   | Managed by page load delays               | Explicit API delay (4s between requests) |
| **Reliability**     | Affected by UI changes                    | More stable (API contract)               |
| **Card Data**       | Scraped from DOM                          | Fetched via EVC API                      |

## Environment Variables

```env
# EVC API Rate Limiting
EVC_API_DELAY_MS=4000  # Delay between EVC API calls (default: 4 seconds)

# Reservation Processing
RESERVATION_PROCESSING_DELAY_MS=1000  # Base delay between reservations
```

## Usage Example

```bash
curl -X POST http://localhost:3000/api/expedia/graphql-retrieval-run-job \
  -H "Content-Type: application/json" \
  -d '{"retrieval_id": "68f4ce37d621740b157f49e1"}'
```

## Error Handling

The API handles the following error scenarios:

1. **Missing retrieval_id**: Returns 400 with error message
2. **Retrieval not found**: Returns 404
3. **No reservations in retrieval**: Returns 400
4. **Missing credentials**: Returns 400
5. **Login failure**: Throws error, updates status to Failed
6. **OTP verification failure**: Throws error, updates status to Failed
7. **GraphQL API errors**: Logs error, continues with next reservation
8. **EVC API rate limits**: Implements retry with exponential backoff
9. **Worker errors**: Updates retrieval status to Failed, returns 500

## Performance Considerations

- **Human-like delays**: 2-5 seconds random delay between reservations
- **EVC rate limiting**: 4-second base delay before each EVC API call
- **Retry logic**: Up to 8 retries for EVC API failures
- **Exponential backoff**: 8s → 16s → 32s → 60s for retries
- **Single property navigation**: Logs in once, queries all reservations via API

## Monitoring and Logging

- All operations are logged using `dualLogInfo()` and `dualLogError()`
- Job logs are stored and uploaded to S3
- Progress updates sent to scraping state manager
- Real-time status updates in Retrieval document

## Future Improvements

1. **Batch GraphQL Queries**: Query multiple reservations in a single GraphQL request
2. **Parallel Processing**: Process multiple properties concurrently
3. **Caching**: Cache session cookies to avoid repeated logins
4. **Webhook Notifications**: Notify external systems on completion
5. **Resume Capability**: Resume from last processed reservation on failure

---

**Created**: October 19, 2025  
**Last Updated**: October 19, 2025  
**Version**: 1.0.0
