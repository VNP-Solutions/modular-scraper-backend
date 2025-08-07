# Modular Scraper Backend

A Node.js backend application for automated web scraping with time-based browser management and resume functionality.

## Features

### ✨ New: Email Error Notifications

- **Automatic Error Alerts**: Sends email notifications when jobs encounter errors
- **Multiple Recipients**: Support for single or multiple email addresses per job
- **Rich Email Content**: Detailed error information, job progress, and troubleshooting steps
- **Multiple Email Providers**: Gmail, Outlook, Yahoo, or custom SMTP support
- **Professional Templates**: HTML and plain text email formats with clear formatting
- **Error Context**: Includes job details, progress percentage, and last processed date

### ✨ Time-Based Browser Management & Resume Functionality

- **Automatic Browser Restarts**: Configurable time limits for browser sessions (default: 1 hour)
- **Smart Time Management**: Uses 5 minutes buffer before the time limit to ensure clean browser restarts
- **Resume Capability**: Automatically resumes scraping from the last completed date if interrupted
- **Progress Tracking**: Tracks job progress and last processed dates in the database
- **Robust Error Handling**: Handles browser crashes and network issues gracefully

### Core Features

- Modular architecture for easy maintenance and scaling
- Automated login and OTP verification
- Property search and reservation management
- Date range processing with chunking
- Real-time progress tracking and logging
- Comprehensive error handling and recovery

## Environment Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Database Configuration
DATABASE_URI=mongodb://localhost:27017/scraper_db

# Server Configuration
PORT=3000

# Browser Time Management
# Time limit for browser sessions with flexible units (default: 1h)
# Supported formats: 10m (minutes), 6h (hours), 2d (days), or plain numbers (hours)
# The system will use 5 minutes less than this limit to restart the browser
BROWSER_TIME_LIMIT=1h

# Scraping Configuration
# Number of days to process in each chunk (default: 2)
CHUNK_SIZE=2

# Email Notification Configuration
# Email service provider (gmail, outlook, yahoo, or use custom SMTP)
EMAIL_SERVICE=gmail
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password_here
EMAIL_FROM=Scraper System <your_email@gmail.com>

# Custom SMTP Configuration (alternative to EMAIL_SERVICE)
# SMTP_HOST=smtp.your-provider.com
# SMTP_PORT=587
```

## Email Notifications Setup

The system automatically sends error notifications to email addresses specified in the `watcher_emails` field of each job. See [EMAIL_CONFIGURATION.md](EMAIL_CONFIGURATION.md) for detailed setup instructions.

### Quick Email Setup

1. **Gmail**: Enable 2FA and generate an App Password
2. **Add to .env**: Set `EMAIL_SERVICE=gmail`, `EMAIL_USER`, and `EMAIL_PASSWORD`
3. **Job Configuration**: Add emails to `watcher_emails` field in your job records

```javascript
// Example job with email notifications
const job = {
  // ... other job fields
  watcher_emails: ["manager@company.com", "developer@company.com"],
};
```

### Email Error Coverage

Email notifications are sent for:

- Login/authentication failures
- Browser crashes and timeouts
- Data extraction errors
- Date processing failures
- Progress tracking issues
- Job completion failures

## Progress File Management

Progress is automatically managed using individual JSON files per job:

- **Location**: `job-progress/` directory in project root
- **File naming**: `{jobId}.json` (one file per job)
- **Auto-cleanup**: Files deleted automatically when jobs complete successfully
- **Persistence**: Survives application restarts
- **Isolation**: Each job has its own progress file
- **Git ignored**: Progress directory excluded from version control

### Time Format Examples

Valid time formats for `BROWSER_TIME_LIMIT`:

| Format | Duration   | Effective Time\* | Use Case               |
| ------ | ---------- | ---------------- | ---------------------- |
| `15m`  | 15 minutes | 10 minutes       | Quick testing          |
| `30m`  | 30 minutes | 25 minutes       | Short sessions         |
| `1h`   | 1 hour     | 55 minutes       | Standard use           |
| `2h`   | 2 hours    | 1h 55m           | Extended sessions      |
| `6h`   | 6 hours    | 5h 55m           | Long-running jobs      |
| `1d`   | 24 hours   | 23h 55m          | Continuous operation   |
| `2`    | 2 hours    | 1h 55m           | Backward compatibility |

\*Effective time = Total time - 5 minute buffer for clean browser restart

## Time-Based Browser Management

### How It Works

1. **Time Tracking**: The system tracks the elapsed time since browser startup
2. **Buffer Time**: Uses 5 minutes less than the configured limit (e.g., 55 minutes for 1-hour limit)
3. **Smart Restart**: When time limit is reached:
   - Saves current progress to database
   - Closes current browser
   - Opens new browser and logs in
   - Resumes from the last processed date
4. **Resume Logic**: If a job is interrupted:
   - System checks for last processed date in database
   - Automatically resumes from the next date

### Example Scenarios

#### Scenario 1: Long Date Range with Time Limits

```
Start Date: 01/21/2024
End Date: 06/21/2024
Time Limit: 1 hour (55 minutes effective)

Process:
1. Start scraping from 01/21/2024
2. Progress saved to: job-progress/{jobId}.json
3. After 55 minutes, completed up to 01/25/2024
4. Browser restarts, resumes from 01/26/2024
5. Continues until 06/21/2024 is reached
6. Progress file automatically deleted on completion
```

#### Scenario 2: Job Interruption and Resume

```
Original Range: 01/21/2024 to 06/21/2024
Completed: 01/21/2024 to 01/27/2024 (then stopped)

Resume:
1. System detects progress file: job-progress/{jobId}.json
2. Reads last processed date: 01/27/2024
3. Calculates next start date: 01/28/2024
4. Resumes with range: 01/28/2024 to 06/21/2024
5. Progress file deleted on successful completion
```

#### Scenario 3: Multiple Concurrent Jobs

```
Job A: 01/01/2024 to 03/31/2024 → job-progress/jobA.json
Job B: 04/01/2024 to 06/30/2024 → job-progress/jobB.json

Each job maintains independent progress files
No interference between jobs
Automatic cleanup when each job completes
```

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up your environment variables (see `.env.example`)
4. Start the application:
   ```bash
   npm run dev
   ```

## Usage

### Basic Scraping with Time Management

The system automatically handles time-based browser restarts and resume functionality. Simply provide the date range and credentials:

```javascript
await main(
  expediaId, // Property ID to scrape
  "01/21/2024", // Start date (MM/DD/YYYY)
  "06/21/2024", // End date (MM/DD/YYYY)
  jobId, // Job ID for tracking
  email, // Login email
  password // Login password
);
```

### Configuring Time Limits

Adjust the `BROWSER_TIME_LIMIT` environment variable with flexible time units:

```env
# Minutes
BROWSER_TIME_LIMIT=30m    # 30 minutes (25 minutes effective)
BROWSER_TIME_LIMIT=90m    # 1.5 hours (85 minutes effective)

# Hours
BROWSER_TIME_LIMIT=2h     # 2 hours (1h 55m effective)
BROWSER_TIME_LIMIT=6h     # 6 hours (5h 55m effective)

# Days
BROWSER_TIME_LIMIT=1d     # 24 hours (23h 55m effective)
BROWSER_TIME_LIMIT=0.5d   # 12 hours (11h 55m effective)

# Backward compatibility (plain numbers treated as hours)
BROWSER_TIME_LIMIT=2      # 2 hours (same as 2h)
```

## Progress Tracking Storage

Progress tracking is handled via an in-memory system with individual file persistence:

- **In-Memory Storage**: Fast access to progress data during runtime
- **Individual Files**: Each job gets its own `{jobId}.json` file in `job-progress/` directory
- **No Database Changes**: Existing job schema remains unchanged
- **Auto-Cleanup**: Progress files deleted automatically when jobs complete successfully
- **Isolation**: No interference between different jobs
- **Recovery**: Automatic progress restoration after application restarts

## API Endpoints

- `GET /api/jobs/:id/progress` - Get job progress and resume status
- `POST /api/jobs/:id/resume` - Manually trigger job resume
- `GET /api/jobs/:id/time-status` - Get current time session status

## Logging

The system provides comprehensive logging for:

- Time session management
- Browser restart events
- Resume operations
- Progress tracking
- Error handling
- Email notification events

## Error Recovery

The system handles various error scenarios:

- **Browser crashes**: Automatic restart and resume with email notifications
- **Network timeouts**: Retry with exponential backoff and error alerts
- **Time limit exceeded**: Clean browser restart with progress save
- **Job interruption**: Resume from last processed date with stakeholder notifications
- **Job failures**: Automatic progress file cleanup and email alerts
- **Corrupted progress files**: Auto-detection and cleanup of invalid JSON

## Development

### Key Components

- `src/common/time-manager.ts` - Time tracking and session management
- `src/common/progress-manager.ts` - In-memory progress tracking with file persistence
- `src/common/email-notifier.ts` - Email notification system for error alerts
- `src/date-split/date-split.ts` - Date processing with restart support
- `src/main.ts` - Main orchestration with restart logic
- `src/date-split/helper.ts` - Resume date calculation utilities

### Running Tests

```bash
npm test
```

### Building for Production

```bash
npm run build
npm run build:start
```

### Testing Email Notifications

```javascript
import { emailNotifier } from "./src/common/email-notifier.js";

// Test email configuration
await emailNotifier.sendTestEmail("test@example.com");
```

## API Documentation

The application provides RESTful APIs for external integration and monitoring.

### Email Notification API

Send error notifications to configured watcher emails for specific jobs. This API allows other developers to integrate email notifications into their workflows.

#### **Base URL**

```
http://localhost:3000/api/notifications
```

#### **Endpoints**

##### 1. Send Error Notification

**POST** `/email/error`

Send an error notification email for a specific job to configured watcher emails.

**Request Body:**

```json
{
  "jobId": "string (required)",
  "errorMessage": "string (required)",
  "errorDetails": "object (optional)",
  "additionalData": {
    "stage": "string (optional)",
    "progressPercentage": "number (optional)",
    "lastProcessedDate": "string (optional)"
  }
}
```

**Example Requests:**

_Basic Error Notification:_

```bash
curl -X POST http://localhost:3000/api/notifications/email/error \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "job_12345",
    "errorMessage": "Database connection failed"
  }'
```

_Detailed Error with Context:_

```bash
curl -X POST http://localhost:3000/api/notifications/email/error \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "job_12345",
    "errorMessage": "Scraping process failed during data extraction",
    "errorDetails": {
      "stack": "Error: Timeout waiting for element...",
      "code": "TIMEOUT_ERROR"
    },
    "additionalData": {
      "stage": "data_scraping",
      "progressPercentage": 65.5,
      "lastProcessedDate": "2025-01-02"
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "message": "Email notification sent successfully",
  "jobId": "job_12345",
  "timestamp": "2025-01-03T10:30:00.000Z"
}
```

**Status Codes:**

- `200`: Email sent successfully
- `400`: Missing required fields (jobId or errorMessage)
- `404`: Job not found with the provided ID
- `500`: Internal server error

##### 2. Test Email Configuration

**GET** `/email/test`

Test if the email notification system is properly configured.

**Example Request:**

```bash
curl -X GET http://localhost:3000/api/notifications/email/test
```

**Response:**

```json
{
  "success": true,
  "message": "Email notification system is ready",
  "configured": true
}
```

#### **JavaScript/TypeScript Integration**

```javascript
// Example integration in Node.js/TypeScript
async function sendErrorNotification(jobId, error, stage = null) {
  try {
    const response = await fetch(
      "http://localhost:3000/api/notifications/email/error",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobId: jobId,
          errorMessage: error.message,
          errorDetails: {
            stack: error.stack,
            name: error.name,
          },
          additionalData: {
            stage: stage,
            timestamp: new Date().toISOString(),
          },
        }),
      }
    );

    const result = await response.json();
    console.log("Email notification sent:", result);
  } catch (err) {
    console.error("Failed to send email notification:", err);
  }
}

// Usage
try {
  // Your application logic here
  await someRiskyOperation();
} catch (error) {
  await sendErrorNotification("my_job_123", error, "data_processing");
}
```

#### **Python Integration**

```python
import requests
import json

def send_error_notification(job_id, error_message, stage=None, progress=None):
    """Send error notification via API"""
    url = "http://localhost:3000/api/notifications/email/error"

    payload = {
        "jobId": job_id,
        "errorMessage": error_message
    }

    if stage or progress:
        payload["additionalData"] = {}
        if stage:
            payload["additionalData"]["stage"] = stage
        if progress:
            payload["additionalData"]["progressPercentage"] = progress

    try:
        response = requests.post(
            url,
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload)
        )

        if response.status_code == 200:
            print(f"Email notification sent successfully: {response.json()}")
        else:
            print(f"Failed to send notification: {response.status_code} - {response.text}")

    except Exception as e:
        print(f"Error sending notification: {e}")

# Usage
try:
    # Your application logic here
    perform_data_processing()
except Exception as e:
    send_error_notification("python_job_456", str(e), "data_processing", 75.5)
```

### API Documentation (Swagger)

Complete API documentation with interactive testing is available at:

```
http://localhost:3000/api-docs
```

The Swagger UI provides:

- Interactive API testing
- Complete parameter descriptions
- Request/response examples
- Error scenario documentation
- Schema definitions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This project is licensed under the ISC License.
