# Browserless Session Persistence Test

This test suite verifies if Browserless can maintain persistent browser sessions for Booking.com authentication, which requires multiple logins to build trust.

## Overview

The test simulates the following scenarios:
1. Creating a new browser session and navigating to Booking.com
2. Attempting to maintain the session after disconnection
3. Testing session persistence with keepalive parameter
4. Capturing screenshots at each stage

## Running the Tests

### Method 1: CLI Script (Recommended)

```bash
# From the project root
cd modular-scraper-backend

# Run the test script
./src/tests/browserless/run-test.sh

# Or using npm
npm run test:session
```

### Method 2: Direct Node Execution

```bash
# From modular-scraper-backend directory
npm run test:browserless
```

### Method 3: Via API (When Server is Running)

1. Start the modular-scraper-backend server:
   ```bash
   cd modular-scraper-backend
   npm run dev
   ```

2. Trigger the test via API:
   ```bash
   # Start full test
   curl -X POST http://localhost:3000/api/test/browserless/session

   # Check test status
   curl http://localhost:3000/api/test/browserless/status

   # Run quick connection test
   curl -X POST http://localhost:3000/api/test/browserless/quick
   ```

### Method 4: Via Swagger UI

1. Navigate to: http://localhost:3000/api-docs
2. Find the "Testing" section
3. Use the endpoints:
   - `POST /api/test/browserless/session` - Run full test
   - `GET /api/test/browserless/status` - Check test status
   - `POST /api/test/browserless/quick` - Quick connection test

## Test Output

### Console Output
The test provides detailed console output including:
- Connection status to Browserless
- Live session URL for monitoring
- Test progress for each scenario
- Final summary with recommendations

### Screenshots
Screenshots are saved in the `screenshots/` directory:
- `booking-initial.png` - Initial Booking.com page
- `booking-login-page.png` - Login page after clicking sign-in
- `booking-reconnected.png` - Page state after reconnection attempt
- `booking-persistent-session.png` - Result of keepalive test

### Live Monitoring
When a test runs, it generates a live URL that you can open in your browser to watch the automation in real-time:
```
Live session URL: https://production-sfo.browserless.io/live/abc123...
```

## Test Results Interpretation

### Successful Test
- ✅ Browser connects to Browserless successfully
- ✅ Navigation to Booking.com works
- ✅ Screenshots are captured
- ❌ Session reconnection fails (expected - Browserless doesn't support this)
- ✅ Keepalive parameter maintains session for specified duration

### Recommendations Based on Results
1. **Use Keepalive**: Add `&keepalive=300000` (5 minutes) to maintain sessions
2. **Cookie Management**: Store auth cookies and restore them on new sessions
3. **Session Pool**: Implement multiple concurrent sessions for reliability
4. **Trust Building**: Gradually increase session duration and actions

## Troubleshooting

### Connection Failed
- Check BROWSERLESS_TOKEN in .env file
- Verify internet connectivity
- Check Browserless service status

### Navigation Timeout
- Increase timeout values in the test
- Check if Booking.com is accessible
- Verify no IP blocking

### Missing Screenshots
- Ensure write permissions in project directory
- Check available disk space
- Verify screenshots directory exists

## Next Steps

Based on test results, implement:
1. Session cookie storage mechanism
2. Automated trust-building workflow
3. Session pool manager for concurrent scraping
4. Retry logic with cookie restoration

## Environment Variables

Required in `.env`:
```
BROWSERLESS_TOKEN=your_browserless_token_here
```

## Support

For issues or questions:
1. Check server logs for detailed error messages
2. Review screenshots for visual debugging
3. Monitor live session URL during test execution