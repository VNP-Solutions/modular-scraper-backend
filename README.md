# Modular Scraper Backend

A Node.js backend application for automated web scraping with worker thread parallelization, supporting both **Expedia** and **Agoda** platforms, featuring time-based browser management and resume functionality.

## Features

### ✨ New: Worker Thread System

- **Parallel Job Processing**: Multiple scraping jobs can run simultaneously using worker threads
- **Thread Pool Management**: Configurable worker pool with automatic thread lifecycle management
- **Queue Management**: Jobs are queued when all workers are busy, with configurable queue size
- **Busy Response**: Returns "All server busy, try again" when no threads are available
- **Graceful Shutdown**: Proper cleanup of worker threads on application shutdown
- **Error Isolation**: Job failures in one worker don't affect other workers
- **Resource Management**: Automatic worker recreation on crashes or timeouts

### ✨ Time-Based Browser Management & Resume Functionality

- **Automatic Browser Restarts**: Configurable time limits for browser sessions (default: 1 hour)
- **Smart Time Management**: Uses 5 minutes buffer before the time limit to ensure clean browser restarts
- **Resume Capability**: Automatically resumes scraping from the last completed date if interrupted
- **Progress Tracking**: Tracks job progress and last processed dates in the database
- **Robust Error Handling**: Handles browser crashes and network issues gracefully

### ✨ Multi-Platform Support

- **Dual Platform Integration**: Supports both Expedia and Agoda scraping in the same system
- **Unified Worker Pool**: Single worker thread pool handles jobs from both platforms
- **Platform-Specific Authentication**:
  - Expedia: Traditional username/password login
  - Agoda: Email-based sign-in link authentication with OTP support
- **Credential Management**: Separate credential storage for each platform per property
- **Email Integration**: Gmail API integration for Agoda sign-in link extraction
- **Error Notifications**: Multi-provider email notification system for job failures

### Core Features

- Modular architecture for easy maintenance and scaling
- Automated login and OTP verification for both platforms
- Property search and reservation management
- Date range processing with chunking
- Real-time progress tracking and logging
- Comprehensive error handling and recovery
- CSV processing and export functionality
- Need Help automation for Agoda support tickets

## Environment Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Database Configuration
DATABASE_URI=mongodb://localhost:27017/scraper_db

# Server Configuration
PORT=3000
NODE_ENV=development

# Worker Thread Configuration
# Number of worker threads to create (default: 3)
MAX_WORKER_THREADS=3



# Maximum number of jobs to queue when all workers are busy (default: 10)
WORKER_QUEUE_SIZE=10

# Browser Time Management
# Time limit for browser sessions with flexible units (default: 1h)
# Supported formats: 10m (minutes), 6h (hours), 2d (days), or plain numbers (hours)
# The system will use 5 minutes less than this limit to restart the browser
BROWSER_TIME_LIMIT=1h

# Scraping Configuration
# Number of days to process in each chunk (default: 2)
CHUNK_SIZE=2

# AWS S3 Configuration (for log storage)
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_S3_BUCKET_NAME=your-s3-bucket-name
AWS_S3_REGION=us-east-1

# Google OAuth Configuration (for Gmail API access)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
TOKEN_PATH=token.json

# Email Notification Configuration
# Option 1: Service-based (Gmail, Outlook)
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=your-email@gmail.com

# Option 2: SMTP-based (Custom email server)
# SMTP_HOST=smtp.yourdomain.com
# SMTP_PORT=587
# EMAIL_USER=your-email@yourdomain.com
# EMAIL_PASSWORD=your-email-password
# EMAIL_FROM=your-email@yourdomain.com

# Steel SDK Configuration (for production browser automation)
STEEL_API_KEY=your-steel-api-key

# BrowserBase Configuration (alternative browser service)
BROWSERBASE_API_KEY=your-browserbase-api-key
BROWSERBASE_PROJECT_ID=your-browserbase-project-id
```

### Worker Thread Configuration

The worker thread system can be configured with these environment variables:

| Variable             | Default | Description                                 |
| -------------------- | ------- | ------------------------------------------- |
| `MAX_WORKER_THREADS` | 3       | Number of worker threads in the pool        |
| `WORKER_QUEUE_SIZE`  | 10      | Maximum jobs to queue when workers are busy |

### Worker Thread Features

- **Isolated Execution**: Each job runs in its own worker thread with isolated memory
- **Automatic Scaling**: Configurable number of workers based on server capacity
- **Queue Management**: Jobs are queued when all workers are busy

- **Graceful Degradation**: Returns busy message when queue is full
- **Health Monitoring**: Track worker status via API endpoint

### Job Processing Flow

1. **Job Submission**: API receives job request
2. **Worker Availability Check**: System checks for available workers
3. **Queue Management**: If no workers available, job is queued (or rejected if queue full)
4. **Worker Assignment**: Available worker picks up job from queue
5. **Isolated Execution**: Job runs in dedicated worker thread
6. **Result Collection**: Worker returns results to main thread
7. **Resource Cleanup**: Worker becomes available for next job

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

## API Endpoints

### Worker Pool Management

- `GET /api/worker-pool/status` - Get worker pool status and statistics

### Job Management

#### Expedia Jobs

- `POST /api/expedia/property-run-job` - Start Expedia property scraping job (uses worker threads)
- `POST /api/expedia/rerun-failed-job` - Rerun failed or partial Expedia jobs (uses worker threads)
- `POST /api/expedia/reservation-run-job` - Start Expedia reservation scraping job (uses worker threads)
- 
### Progress Monitoring

- `GET /api/jobs/:id/progress` - Get job progress and resume status
- `POST /api/jobs/:id/resume` - Manually trigger job resume
- `GET /api/jobs/:id/time-status` - Get current time session status

### Scraping Control

- `POST /api/scraping/pause` - Pause current scraping operations
- `POST /api/scraping/resume` - Resume paused scraping operations
- `POST /api/scraping/stop` - Stop current scraping operations

### Worker Pool Status Response

```json
{
  "status": 200,
  "message": "Worker pool status retrieved successfully",
  "workerPool": {
    "totalWorkers": 3,
    "availableWorkers": 2,
    "busyWorkers": 1,
    "queuedJobs": 0,
    "workers": [
      {
        "id": "worker-0",
        "isAvailable": false,
        "currentJobId": "507f1f77bcf86cd799439011",
        "startTime": "2024-01-15T10:30:00.000Z",
        "lastActivity": "2024-01-15T10:35:00.000Z"
      }
    ]
  }
}
```

### Busy Server Response

When all workers are busy and queue is full:

```json
{
  "status": 200,
  "message": "All server busy, try again",
  "workerStatus": {
    "totalWorkers": 3,
    "availableWorkers": 0,
    "busyWorkers": 3,
    "queuedJobs": 10
  }
}
```

## Logging

The system provides comprehensive logging for:

- Worker thread lifecycle events
- Job assignment and completion
- Time session management
- Browser restart events
- Resume operations
- Progress tracking
- Error handling and recovery

## Error Recovery

The system handles various error scenarios:

- **Worker crashes**: Automatic worker recreation and job retry

- **Browser crashes**: Automatic restart and resume within worker
- **Network timeouts**: Retry with exponential backoff
- **Time limit exceeded**: Clean browser restart within worker
- **Job interruption**: Resume from last processed date
- **Job failures**: Automatic progress file cleanup on any error
- **Corrupted progress files**: Auto-detection and cleanup of invalid JSON

## Development

### Key Components

- `src/common/worker-pool.ts` - Worker thread pool management
- `src/common/worker-types.ts` - TypeScript interfaces for worker communication
- `src/workers/scraping-worker.ts` - Worker thread implementation
- `src/common/time-manager.ts` - Time tracking and session management
- `src/common/progress-manager.ts` - In-memory progress tracking with file persistence
- `src/date-split/date-split.ts` - Date processing with restart support
- `src/main.ts` - Main orchestration with restart logic
- `src/date-split/helper.ts` - Resume date calculation utilities

### Running Tests

```bash
npm test
```

### Development Mode

```bash
npm run dev
```

This runs the application with ts-node and enables worker threads to run TypeScript files directly.

### Building for Production

```bash
npm run build
npm run build:start
```

In production mode, compiled JavaScript worker files are used for better performance.

### Environment Setup

1. Copy environment variables:

```bash
cp .env.example .env
```

2. Configure your database and worker settings

3. Install dependencies:

```bash
npm install
```

4. Run in development:

```bash
npm run dev
```

## Performance Considerations

### Worker Thread Scaling

- **CPU-bound tasks**: Set `MAX_WORKER_THREADS` to number of CPU cores
- **I/O-bound tasks**: Can exceed CPU core count (2-3x cores is often optimal)
- **Memory usage**: Each worker creates its own V8 isolate (~10-30MB overhead per worker)
- **Browser instances**: Each worker may create its own browser instance

### Recommended Settings

| Server Specs          | MAX_WORKER_THREADS | WORKER_QUEUE_SIZE |
| --------------------- | ------------------ | ----------------- |
| 2 CPU cores, 4GB RAM  | 2-3                | 5-10              |
| 4 CPU cores, 8GB RAM  | 3-6                | 10-20             |
| 8 CPU cores, 16GB RAM | 6-12               | 20-50             |

### Monitoring

Monitor these metrics for optimal performance:

- Worker pool utilization (`/api/worker-pool/status`)
- Queue length and wait times
- Job completion rates
- Memory usage per worker
- Browser resource consumption

## Docker Support

The worker thread system is fully compatible with Docker deployments. Make sure to:

1. Set appropriate resource limits
2. Configure `MAX_WORKER_THREADS` based on container resources
3. Use production Node.js image for better worker performance
4. Mount volumes for persistent progress files if needed

## Production Deployment

### Environment Variables

Set these in production:

```env
NODE_ENV=production
MAX_WORKER_THREADS=6
WORKER_QUEUE_SIZE=20
```

### Process Management

Use process managers like PM2 for production:

```json
{
  "name": "modular-scraper",
  "script": "dist/index.js",
  "instances": 1,
  "exec_mode": "fork",
  "env": {
    "NODE_ENV": "production",
    "MAX_WORKER_THREADS": "6"
  }
}
```

Note: Use `fork` mode, not `cluster` mode, as worker threads provide the parallelization.
