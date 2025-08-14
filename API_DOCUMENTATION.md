# Modular Scraper Backend - API Documentation

## 🌐 **Base URL**

```
http://localhost:3000
```

## 📚 **Interactive API Documentation**

Access the complete Swagger documentation at:

```
http://localhost:3000/api-docs
```

---

## 🏥 **Health & Authentication Endpoints**

### **Health Check**

```http
GET /
```

**Description**: Check if the server is running and accessible.

**Response**:

```json
{
  "messge": "Connection established on modular-scraper-backend"
}
```

### **OAuth Authentication**

```http
GET /auth
```

**Description**: Initiate OAuth authentication flow for Expedia services.

### **OAuth Callback**

```http
GET /oauth2callback?code={code}&state={state}
```

**Description**: Handle OAuth callback after user authentication.

---

## 🎛️ **Scraping Control Endpoints**

### **Get Scraping Status**

```http
GET /api/scraping/status
```

**Description**: Retrieve current state and progress of scraping operations.

**Response**:

```json
{
  "status": 200,
  "message": "Scraping status retrieved successfully",
  "data": {
    "isRunning": true,
    "isPaused": false,
    "currentJobId": "507f1f77bcf86cd799439011",
    "startTime": "2024-01-01T10:00:00.000Z"
  }
}
```

### **Pause Scraping**

```http
POST /api/scraping/pause
```

**Description**: Gracefully pause the currently running scraping job.

### **Resume Scraping**

```http
POST /api/scraping/resume
```

**Description**: Resume a previously paused scraping job.

### **Stop Scraping**

```http
POST /api/scraping/stop
```

**Description**: Completely stop the current scraping job.

---

## 📋 **Job Monitoring Endpoints**

### **Get Job Progress**

```http
GET /api/jobs/{jobId}/progress
```

**Description**: Get detailed progress information for a specific job.

**Response**:

```json
{
  "status": 200,
  "message": "Job progress retrieved successfully",
  "job": {
    "id": "507f1f77bcf86cd799439011",
    "status": "Running",
    "property_name": "Sample Hotel",
    "portfolio_name": "Sample Portfolio"
  },
  "progress": {
    "totalItems": 150,
    "itemsWithCardInfo": 140,
    "itemsWithPaymentInfo": 135,
    "completionPercentage": 90
  }
}
```

### **Get Job Items**

```http
GET /api/jobs/{jobId}/items?page=1&limit=10&sortBy=createdAt&sortOrder=desc
```

**Description**: Get paginated scraped reservation data for a specific job.

**Query Parameters**:

- `page` (integer): Page number (default: 1)
- `limit` (integer): Items per page (default: 10)
- `sortBy` (string): Field to sort by (default: createdAt)
- `sortOrder` (string): Sort order - asc/desc (default: desc)
- `search` (string): Search by guest name or reservation ID
- `reasonForCharge` (string): Filter by reason for charge

**Response**:

```json
{
  "status": 200,
  "message": "Job items retrieved successfully",
  "items": [
    {
      "guest_name": "John Doe",
      "reservation_id": "12345",
      "confirmation_number": "CONF123",
      "check_in_date": "2024-01-15T00:00:00.000Z",
      "check_out_date": "2024-01-17T00:00:00.000Z",
      "room_type": "Standard Room",
      "booking_amount": 299.99,
      "has_card_info": true,
      "has_payment_info": true
    }
  ],
  "metadata": {
    "totalDocuments": 150,
    "currentPage": 1,
    "totalPage": 15,
    "limit": 10
  }
}
```

### **Get Job Log**

```http
GET /api/jobs/{jobId}/log
```

**Description**: Get the S3 URL for the job's log file.

### **Get Worker Pool Status**

```http
GET /api/jobs/worker-pool/status
```

**Description**: Get detailed information about the worker pool.

**Response**:

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
        "id": "worker-1",
        "isAvailable": false,
        "currentJobId": "507f1f77bcf86cd799439011",
        "startTime": "2024-01-01T10:00:00.000Z"
      }
    ]
  }
}
```

---

## 🏨 **Expedia Scraping Endpoints**

### **Start Property Scraping Job**

```http
POST /api/expedia/property-run-job
```

**Description**: Start a new Expedia property scraping job.

**Request Body**:

```json
{
  "startDate": "01/01/2024",
  "endDate": "01/31/2024",
  "jobId": "507f1f77bcf86cd799439011"
}
```

**Response**:

```json
{
  "status": 200,
  "message": "Property scraping completed successfully",
  "expediaId": "12345",
  "jobId": "507f1f77bcf86cd799439011",
  "progress": {
    "totalItems": 150,
    "itemsWithCardInfo": 140,
    "itemsWithPaymentInfo": 135,
    "completionPercentage": 90
  },
  "finalStatus": "Completed",
  "logInfo": {
    "logFilePath": "/logs/job_507f1f77bcf86cd799439011.log",
    "logEntriesCount": 1247,
    "note": "Log file uploaded to S3 and deleted locally"
  }
}
```

### **Rerun Failed Job**

```http
POST /api/expedia/rerun-failed-job
```

**Description**: Rerun a job that has failed or partially completed.

**Request Body**:

```json
{
  "startDate": "01/01/2024",
  "endDate": "01/31/2024",
  "jobId": "507f1f77bcf86cd799439011"
}
```

### **Start Reservation Scraping Job**

```http
POST /api/expedia/reservation-run-job
```

**Description**: Start a new reservation scraping job.

**Request Body**:

```json
{
  "reservations": [
    {
      "reservationId": "RES123",
      "propertyId": "PROP456"
    },
    {
      "reservationId": "RES124",
      "propertyId": "PROP457"
    }
  ]
}
```

### **Start GraphQL Scraping Job**

```http
POST /api/expedia/graphql-run-job
```

**Description**: Start a GraphQL-based property scraping job for more efficient data retrieval.

**Request Body**:

```json
{
  "startDate": "01/01/2024",
  "endDate": "01/31/2024",
  "jobId": "507f1f77bcf86cd799439011"
}
```

---

## 🏖️ **Agoda Scraping Endpoints**

### **Start Agoda Property Scraping Job**

```http
POST /api/agoda/property-run-job
```

**Description**: Execute an Agoda property scraping job with email-based authentication.

**Request Body**:

```json
{
  "startDate": "01/01/2025",
  "endDate": "01/31/2025",
  "jobId": "6892f4bf9df8bc296bdcdff0"
}
```

**Response**:

```json
{
  "status": 200,
  "message": "Agoda property scraping completed successfully",
  "agodaId": "123456",
  "jobId": "507f1f77bcf86cd799439011",
  "progress": {
    "totalItems": 150,
    "itemsWithCardInfo": 150,
    "itemsWithPaymentInfo": 145,
    "completionPercentage": 97
  },
  "finalStatus": "Completed",
  "logInfo": {
    "logFilePath": "/logs/job_507f1f77bcf86cd799439011.log",
    "logEntriesCount": 1247,
    "note": "Log file uploaded to S3 and deleted locally"
  }
}
```

### **Rerun Failed Agoda Job**

```http
POST /api/agoda/rerun-failed-job
```

**Description**: Rerun an Agoda job that has failed or partially completed.

**Request Body**:

```json
{
  "startDate": "01/01/2024",
  "endDate": "01/31/2024",
  "jobId": "507f1f77bcf86cd799439011"
}
```

---

## 🔧 **Authentication Requirements**

### **Expedia Jobs**

Requires property to have:

- `expediaUsername` (property credentials)
- `expediaPassword` (property credentials)
- Valid `expedia_id` (not "0")

### **Agoda Jobs**

Requires property to have:

- `agodaUsername` (property credentials)
- `agodaPassword` (property credentials)
- Valid `agoda_id` (not "0")

---

## ⚠️ **Error Responses**

### **Common Error Formats**

#### **400 Bad Request**

```json
{
  "status": 400,
  "message": "startDate and endDate are required in request body"
}
```

#### **404 Not Found**

```json
{
  "status": 404,
  "message": "Job with ID 507f1f77bcf86cd799439011 not found"
}
```

#### **409 Conflict**

```json
{
  "status": 409,
  "message": "Job 507f1f77bcf86cd799439011 is not in a runnable state. Current status: Running",
  "currentState": {
    "_id": "507f1f77bcf86cd799439011",
    "job_status": "Running",
    "property_name": "Sample Hotel"
  }
}
```

#### **500 Internal Server Error**

```json
{
  "status": 500,
  "message": "Error processing property search",
  "error": "Detailed error message"
}
```

### **Worker Busy Response**

```json
{
  "status": 200,
  "message": "All workers busy, try again",
  "workerStatus": {
    "totalWorkers": 3,
    "availableWorkers": 0,
    "busyWorkers": 3,
    "queuedJobs": 5
  }
}
```

---

## 📊 **Job Status Values**

| Status      | Description                      |
| ----------- | -------------------------------- |
| `Pending`   | Job created but not started      |
| `Running`   | Job currently being processed    |
| `Completed` | Job finished successfully        |
| `Partial`   | Job completed with some failures |
| `Failed`    | Job failed completely            |
| `Paused`    | Job temporarily paused           |

---

## 🔄 **Rate Limiting**

- **Worker Pool Limit**: Jobs are queued when all workers are busy
- **Concurrent Jobs**: Maximum determined by worker pool size
- **Resource Management**: Automatic resource allocation and cleanup

---

## 📝 **Best Practices**

### **Job Management**

1. Check worker pool status before submitting jobs
2. Monitor job progress regularly
3. Handle worker busy responses appropriately
4. Use rerun endpoints for failed jobs

### **Error Handling**

1. Implement proper retry logic for worker busy responses
2. Check job status before operations
3. Validate required credentials before job submission
4. Monitor job logs for detailed error information

### **Performance**

1. Use GraphQL endpoints for Expedia when possible
2. Batch reservation jobs when applicable
3. Monitor worker pool utilization
4. Implement appropriate timeouts

---

## 🔗 **Related Resources**

- **Swagger Documentation**: `/api-docs`
- **Project Structure**: See `PROJECT_STRUCTURE.md`
- **Health Check**: `/`
- **Worker Status**: `/api/jobs/worker-pool/status`
