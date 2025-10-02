# Booking.com VCCS Management API

This document explains how to use the new VCCS (Virtual Credit Card) Management functionality that replaces browser automation with direct API calls for better performance and reliability.

## Overview

The VCCS Management system allows you to:

1. Extract URL parameters from the VCCS management page
2. Make direct API calls to retrieve VCCS data
3. Process each reservation to get card details
4. Store the data in the database

## How It Works

### Traditional Approach (Browser Automation)

- Navigate to VCCS management page
- Click "View all" button
- Scrape each reservation individually
- Extract card details through browser automation

### New Approach (API-Based)

- Extract URL parameters from the current page
- Make direct API calls to Booking.com endpoints
- Process all reservations in parallel
- Store data directly in database

## API Endpoints

### 1. Process VCCS Data

**POST** `/api/booking/vccs/process`

Processes all VCCS reservations using API calls.

**Request Body:**

```json
{
  "url": "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=xu&hotel_id=5827700&ses=345ba6afcadf83888519d25944febe30&route=vccs_to_charge",
  "cookies": "pcm_consent=analytical%3Dtrue; bkng_sso_session=e30; ...",
  "headers": {
    "x-booking-csrf": "your-csrf-token",
    "x-booking-pageview-id": "your-pageview-id"
  },
  "jobId": "job_123456789",
  "propertyId": "property_987654321"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "processed": 2,
    "errors": 0,
    "total": 2,
    "results": [
      {
        "reservationId": "6794005784",
        "vccsData": {
          "hres_id": "6794005784",
          "booking_legal_entity_name": "Booking.com B.V.",
          "current_amount": {
            "amount": "60.7400",
            "currency": "USD",
            "formatted": "US$60.74"
          },
          "expiry_date": "2026-08-06"
        },
        "cardDetails": {
          "cardNumber": "5552 4315 2139 3643",
          "expiry": "07 / 2030",
          "cvv": "914",
          "cardholder": "Booking.com B.V. (Agent)",
          "amountToChargeOrRefund": "US$60.74",
          "reasonForCharge": "MasterCard (virtual credit card)"
        },
        "saved": true
      }
    ],
    "vccsSummary": {
      "totalAmount": "US$121.42",
      "currency": "USD",
      "totalCount": 2
    }
  }
}
```

### 2. Get Card Details for Single Reservation

**POST** `/api/booking/vccs/card-details`

Gets card details for a specific reservation.

**Request Body:**

```json
{
  "reservationId": "6794005784",
  "url": "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=xu&hotel_id=5827700&ses=345ba6afcadf83888519d25944febe30&route=vccs_to_charge",
  "cookies": "your-cookies-here"
}
```

### 3. Extract URL Parameters

**POST** `/api/booking/vccs/extract-params`

Utility endpoint to extract and validate URL parameters.

**Request Body:**

```json
{
  "url": "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=xu&hotel_id=5827700&ses=345ba6afcadf83888519d25944febe30&route=vccs_to_charge"
}
```

## Integration with Existing Scraper

The new VCCS functionality is integrated into the existing BookingScraper. When you run a Booking.com scraping job, it will:

1. Navigate to the VCCS management page (as before)
2. Click "View all" button (as before)
3. **NEW**: Use API calls instead of browser automation to process reservations
4. Store data in the database (as before)

## Usage Examples

### Using the API Directly

```typescript
import { vccsManagementService } from "./services/vccs-management.service.js";

// Extract URL parameters
const urlParams = vccsManagementService.extractUrlParams(vccsUrl);

// Get VCCS data
const vccsData = await vccsManagementService.getVccsData(
  urlParams,
  cookies,
  headers
);

// Process all reservations
const result = await vccsManagementService.processAllVccsReservations(
  vccsData,
  urlParams,
  cookies,
  headers,
  jobId,
  propertyId
);
```

### Using the HTTP API

```bash
# Process all VCCS reservations
curl -X POST http://localhost:3000/api/booking/vccs/process \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=xu&hotel_id=5827700&ses=345ba6afcadf83888519d25944febe30&route=vccs_to_charge",
    "cookies": "your-cookies-here",
    "jobId": "job_123",
    "propertyId": "property_456"
  }'
```

## Required Parameters

### URL Parameters

The VCCS management page URL must contain these parameters:

- `hotel_id`: The hotel ID
- `ses`: Session ID
- `lang`: Language code
- `route`: Must be "vccs_to_charge"

### Cookies

You need to provide valid browser cookies that include:

- Authentication cookies (bkng_sso_session, bkng_sso_auth, etc.)
- Consent cookies (pcm_consent, OptanonConsent, etc.)
- Tracking cookies (\_ga, \_gid, etc.)

### Headers (Optional)

- `x-booking-csrf`: CSRF token for API requests
- `x-booking-pageview-id`: Page view ID for tracking

## Data Storage

The system stores VCCS data in the existing `JobItem` model with the following structure:

```typescript
{
  job_id: string,
  property_id: string,
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
    card_holder_name: string,
    reason_for_charge: string
  },
  has_payment_info: boolean,
  payment_info: {
    total_guest_payment: number,
    total_payout: number,
    amount_to_charge_or_refund: number,
    cancellation_fee: number,
    charge_before: string
  },
  reservation_status: string
}
```

## Error Handling

The system includes comprehensive error handling:

- URL parameter validation
- API response validation
- Individual reservation error handling
- Database operation error handling
- Detailed logging for debugging

## Performance Benefits

### Speed

- **Before**: ~30-60 seconds per reservation (browser automation)
- **After**: ~1-2 seconds per reservation (API calls)

### Reliability

- **Before**: Prone to browser crashes, captcha challenges, network issues
- **After**: Direct API calls with better error handling and retry logic

### Scalability

- **Before**: Limited by browser resources and session timeouts
- **After**: Can process hundreds of reservations efficiently

## Testing

Use the provided test script to verify the functionality:

```bash
# Run the test example
npx ts-node src/examples/vccs-test-example.ts
```

## Troubleshooting

### Common Issues

1. **Invalid URL Parameters**

   - Ensure the URL contains all required parameters
   - Use the `/extract-params` endpoint to validate

2. **Authentication Errors**

   - Verify cookies are valid and not expired
   - Check if session is still active

3. **API Rate Limiting**

   - The system includes delays between requests
   - Monitor for rate limit responses

4. **Card Details Not Found**
   - Some reservations may not have card details available
   - Check the response for error details

### Debugging

Enable detailed logging by setting the log level in your environment:

```bash
export LOG_LEVEL=debug
```

## Migration from Browser Automation

The new API-based approach is automatically used when you run Booking.com scraping jobs. No changes are required to existing job configurations.

However, if you want to use the API directly:

1. Extract the URL and cookies from your browser session
2. Use the `/api/booking/vccs/process` endpoint
3. Monitor the response for processing results

## Security Considerations

- Cookies contain sensitive authentication information
- Store cookies securely and don't log them
- Use HTTPS for all API communications
- Implement proper access controls for the API endpoints

## Support

For issues or questions:

1. Check the logs for detailed error information
2. Use the test script to verify functionality
3. Contact the development team with specific error messages
