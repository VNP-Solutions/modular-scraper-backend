# Modular Scraper Backend

A Node.js backend application for automated web scraping with time-based browser management and resume functionality.

## Features

### ✨ New: Time-Based Browser Management & Resume Functionality

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
```

### Progress File Management

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

## Error Recovery

The system handles various error scenarios:

- **Browser crashes**: Automatic restart and resume
- **Network timeouts**: Retry with exponential backoff
- **Time limit exceeded**: Clean browser restart
- **Job interruption**: Resume from last processed date
- **Job failures**: Automatic progress file cleanup on any error
- **Corrupted progress files**: Auto-detection and cleanup of invalid JSON

## Development

### Key Components

- `src/common/time-manager.ts` - Time tracking and session management
- `src/common/progress-manager.ts` - In-memory progress tracking with file persistence
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

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This project is licensed under the ISC License.
