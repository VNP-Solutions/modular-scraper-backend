# Agoda Worker Thread Implementation

This document describes the worker thread implementation for Agoda scraping in the modular-scraper-backend-original project.

## Overview

The Agoda worker thread implementation provides a robust, scalable solution for running Agoda scraping jobs in parallel without blocking the main application thread. This implementation is modeled after the Expedia worker implementation from the modular-scraper-backend project but specifically adapted for Agoda scraping workflows.

## Architecture

### Components

1. **WorkerPool** (`src/common/worker-pool.ts`) - Manages multiple worker threads
2. **Worker Thread** (`src/workers/agoda-scraping-worker.ts`) - Executes individual Agoda scraping jobs
3. **Worker Types** (`src/common/worker-types.ts`) - Type definitions for worker communication
4. **Route Integration** (`src/routes/agoda/scraping.routes.ts`) - Updated route handler to use workers
5. **S3 Token Management** (`src/common/s3-token.ts`) - S3-based token storage for Gmail authentication

### Key Features

- **Parallel Processing**: Multiple Agoda scraping jobs can run simultaneously
- **Queue Management**: Jobs are queued when all workers are busy
- **Error Handling**: Comprehensive error handling and job recovery
- **Progress Tracking**: Real-time job progress monitoring
- **S3 Integration**: Gmail tokens are stored and retrieved from S3
- **Resource Management**: Automatic worker recovery and cleanup

## File Structure

```
src/
├── common/
│   ├── worker-pool.ts          # Worker pool management
│   ├── worker-types.ts         # Type definitions
│   ├── s3-token.ts            # S3 token operations
│   └── load-token.ts          # Updated to use S3
├── workers/
│   └── agoda-scraping-worker.ts # Agoda worker implementation
└── routes/
    └── agoda/
        ├── scraping.routes.ts     # Updated main route
        └── worker-test.routes.ts  # Testing endpoints
```

## Usage

### Starting a Job

```javascript
// POST /api/agoda/property-run-job
{
  "startDate": "01/01/2024",
  "endDate": "01/31/2024",
  "jobId": "507f1f77bcf86cd799439011"
}
```

The route handler will:

1. Validate job parameters
2. Check worker availability
3. Submit job to worker pool
4. Return immediate response with job status

### Worker Pool Status

```javascript
// GET /api/agoda/worker-status
{
  "status": 200,
  "message": "Agoda worker pool status retrieved successfully",
  "workerStatus": {
    "totalWorkers": 3,
    "availableWorkers": 2,
    "busyWorkers": 1,
    "queuedJobs": 0,
    "workers": [...]
  }
}
```

### Testing Workers

```javascript
// POST /api/agoda/worker-test
{
  "startDate": "01/01/2024",
  "endDate": "01/31/2024",
  "jobId": "test-job-123",
  "agodaId": "12345",
  "agodaUsername": "test@example.com",
  "agodaPassword": "password123"
}
```

## Configuration

### Environment Variables

```bash
# Worker Configuration
MAX_WORKER_THREADS=3        # Number of worker threads
WORKER_QUEUE_SIZE=10        # Maximum queued jobs

# S3 Configuration
AWS_S3_BUCKET=your-bucket   # S3 bucket for token storage
S3_TOKEN_KEY=keyspace/token.json  # S3 key for Gmail token
AWS_REGION=us-east-1        # AWS region

# Database
DATABASE_URI=mongodb://...  # MongoDB connection string
```

### Worker Pool Configuration

The worker pool can be configured via environment variables or constructor parameters:

```typescript
const workerPool = new WorkerPool({
  maxWorkers: 3, // Number of worker threads
  queueSize: 10, // Maximum queue size
});
```

## Job Types

### Agoda Property Run

- **Type**: `agoda-property-run`
- **Description**: Executes complete Agoda property scraping
- **Parameters**: jobId, startDate, endDate, agodaId, agodaUsername, agodaPassword

### Agoda Rerun Failed

- **Type**: `agoda-rerun-failed`
- **Description**: Reruns failed or partial Agoda jobs
- **Parameters**: jobId, originalStatus, startDate, endDate

## Error Handling

### Worker-Level Errors

- Worker crashes are automatically detected
- Failed workers are recreated after 1-second delay
- Job errors are properly propagated to the main thread

### Job-Level Errors

- Failed jobs are marked with appropriate status
- Progress tracking is updated on errors
- Cleanup operations are performed automatically

## S3 Token Integration

### Gmail Token Management

The implementation uses S3 for storing Gmail authentication tokens:

```typescript
// Load token from S3
const tokenData = await readTokenDataFromS3<GoogleTokenData>();

// Save token to S3
await uploadTokenToS3FromData(tokenData);
```

### Benefits

- **Centralized Storage**: Tokens are stored centrally in S3
- **High Availability**: No dependency on local file system
- **Automatic Sync**: Tokens are automatically synchronized across instances
- **Backup**: S3 provides automatic backup and versioning

## Monitoring and Debugging

### Worker Status Monitoring

```bash
curl http://localhost:3000/api/agoda/worker-status
```

### Job Progress Tracking

- Real-time progress updates via worker messages
- Progress stored in database for persistence
- Detailed logging with job context

### Debugging Features

- Test endpoints for worker validation
- Comprehensive error logging
- Worker pool status inspection

## Performance Considerations

### Scaling

- Default: 3 worker threads
- Can be increased based on system resources
- Queue size prevents memory exhaustion

### Resource Usage

- Each worker maintains its own MongoDB connection
- Browser instances are created per job
- Memory cleanup after job completion

## Migration Notes

### From Synchronous to Worker-Based

The original Agoda route was updated to use workers:

**Before:**

```typescript
// Direct execution in main thread
await agoda(agodaId, startDate, endDate, jobId, agodaUsername, agodaPassword);
```

**After:**

```typescript
// Execution in worker thread
const result = await agodaWorkerPool.executeJob(workerJobData);
```

### Backwards Compatibility

- Same API endpoints maintained
- Same response formats
- Same error handling patterns

## Troubleshooting

### Common Issues

1. **Workers Not Starting**

   - Check MongoDB connection
   - Verify TypeScript compilation
   - Check file permissions

2. **S3 Token Errors**

   - Verify AWS credentials
   - Check S3 bucket permissions
   - Validate bucket/key configuration

3. **Job Failures**
   - Check worker logs
   - Verify job parameters
   - Monitor resource usage

### Debug Commands

```bash
# Check worker status
curl http://localhost:3000/api/agoda/worker-status

# Test worker functionality
curl -X POST http://localhost:3000/api/agoda/worker-test \
  -H "Content-Type: application/json" \
  -d '{"startDate":"01/01/2024","endDate":"01/31/2024","jobId":"test"}'
```

## Future Enhancements

### Planned Features

1. **Dynamic Scaling**: Auto-adjust worker count based on load
2. **Health Checks**: Periodic worker health monitoring
3. **Metrics Collection**: Detailed performance metrics
4. **Load Balancing**: Intelligent job distribution

### Performance Optimizations

1. **Connection Pooling**: Optimize database connections
2. **Resource Caching**: Cache frequently used resources
3. **Memory Management**: Improved garbage collection
4. **Batch Processing**: Process multiple reservations per worker
