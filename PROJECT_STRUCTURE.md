# Modular Scraper Backend - Project Structure Documentation

## Overview

This is the unified modular scraper backend that combines Expedia manual scraping, Expedia GraphQL scraping, and Agoda scraping functionality under a single, centralized worker thread management system. The project has been restructured to provide clear separation of concerns while maintaining unified resource management.

## Project Architecture

### 🏗️ **Unified Worker System**

All scraping tasks (Expedia manual, Expedia GraphQL, and Agoda) now use a single worker pool for optimal resource management:

- **Single Worker Pool**: All job types are processed through `src/common/worker-pool.ts`
- **Unified Worker Thread**: `src/workers/scraping-worker.ts` handles all job types
- **Resource Optimization**: Prevents resource conflicts and enables better scaling

### 📁 **Directory Structure**

```
modular-scraper-backend/
├── src/
│   ├── agoda/                     # Agoda-specific scraping modules
│   │   ├── booking-data/          # Booking data extraction
│   │   ├── login-system/          # Email-based authentication
│   │   └── need-help/             # Help form automation
│   ├── app/                       # Main Express application
│   ├── common/                    # Shared utilities and managers
│   │   ├── worker-pool.ts         # Unified worker pool
│   │   ├── worker-types.ts        # Job type definitions
│   │   ├── progress-manager.ts    # Job progress tracking
│   │   └── scraping-state.ts      # Scraping state management
│   ├── models/                    # Database schemas
│   ├── routes/                    # Organized route handlers
│   │   ├── shared/                # Common functionality routes
│   │   ├── expedia/               # Expedia-specific routes
│   │   └── agoda/                 # Agoda-specific routes
│   ├── services/                  # Business logic services
│   └── workers/                   # Worker thread implementations
└── README.md
```

## 🛣️ **Route Organization**

### **Centralized Route Management**

Routes are organized by functionality and platform for better maintainability:

#### **Shared Routes** (`/routes/shared/`)

- **Health Routes**: Server health checks and authentication
- **Job Monitoring**: Job progress, items, and logs
- **Scraping Control**: Start, pause, resume, stop operations

#### **Platform-Specific Routes**

- **Expedia Routes** (`/routes/expedia/`): Manual and GraphQL scraping
- **Agoda Routes** (`/routes/agoda/`): Agoda-specific scraping

## 📊 **Available API Endpoints**

### **🏥 Health & Authentication**

```
GET  /                    # Health check
GET  /auth                # OAuth authentication
GET  /oauth2callback      # OAuth callback
```

### **🎛️ Scraping Control**

```
GET  /api/scraping/status   # Get scraping status
POST /api/scraping/pause    # Pause current job
POST /api/scraping/resume   # Resume paused job
POST /api/scraping/stop     # Stop current job
```

### **📋 Job Monitoring**

```
GET /api/jobs/{jobId}/progress     # Job progress details
GET /api/jobs/{jobId}/items        # Job scraped data (paginated)
GET /api/jobs/{jobId}/log          # Job log file link
GET /api/jobs/worker-pool/status   # Worker pool status
```

### **🏨 Expedia Scraping**

```
POST /api/expedia/property-run-job      # Manual property scraping
POST /api/expedia/rerun-failed-job      # Rerun failed jobs
POST /api/expedia/reservation-run-job   # Reservation scraping
POST /api/expedia/graphql-run-job       # GraphQL property scraping
```

### **🏖️ Agoda Scraping**

```
POST /api/agoda/property-run-job      # Agoda property scraping
POST /api/agoda/rerun-failed-job      # Rerun failed Agoda jobs
```

## 🔧 **Worker Job Types**

The unified worker system supports the following job types:

| Job Type             | Platform | Description                   |
| -------------------- | -------- | ----------------------------- |
| `property-run`       | Expedia  | Manual property scraping      |
| `rerun-failed`       | Expedia  | Rerun failed/partial jobs     |
| `reservation-run`    | Expedia  | Reservation-specific scraping |
| `graphql-run`        | Expedia  | GraphQL-based scraping        |
| `agoda-property-run` | Agoda    | Agoda property scraping       |
| `agoda-rerun-failed` | Agoda    | Rerun failed Agoda jobs       |

## 📝 **Job Parameters**

### **Expedia Jobs**

```json
{
  "startDate": "01/01/2024", // MM/DD/YYYY format
  "endDate": "01/31/2024", // MM/DD/YYYY format
  "jobId": "507f1f77bcf86cd799439011" // MongoDB ObjectId
}
```

### **Agoda Jobs**

```json
{
  "startDate": "01/01/2024", // MM/DD/YYYY format
  "endDate": "01/31/2024", // MM/DD/YYYY format
  "jobId": "507f1f77bcf86cd799439011" // MongoDB ObjectId
}
```

### **Reservation Jobs**

```json
{
  "reservations": [
    {
      "reservationId": "RES123",
      "propertyId": "PROP456"
    }
  ]
}
```

## 🗄️ **Database Models**

### **Key Models**

- **Job**: Main job entity with status tracking
- **JobItem**: Individual scraped reservations
- **Property**: Hotel/property information
- **PropertyCredentials**: Platform-specific login credentials
- **JobQueueUrl**: URL queue management for load balancing

### **Property Credentials**

Supports multiple platforms:

```typescript
{
  property_id: ObjectId,
  expediaUsername?: string,
  expediaPassword?: string,
  agodaUsername?: string,
  agodaPassword?: string,
  bookingUsername?: string,
  bookingPassword?: string,
  // ... other fields
}
```

## 🚀 **Getting Started**

### **Prerequisites**

- Node.js 18+
- MongoDB
- Required environment variables (see .env.example)

### **Installation**

```bash
cd modular-scraper-backend
npm install
npm run dev
```

### **API Documentation**

Access Swagger documentation at: `http://localhost:3000/api-docs`

## 🔐 **Authentication & Security**

### **Expedia Authentication**

- Uses traditional username/password authentication
- Credentials stored in PropertyCredentials model

### **Agoda Authentication**

- Email-based sign-in link authentication
- Automatic Gmail integration for link retrieval
- OTP support for two-factor authentication

## 📈 **Monitoring & Logging**

### **Progress Tracking**

- Real-time job progress updates
- Completion percentage calculations
- Item-level status tracking

### **Logging**

- Centralized logging system
- S3 log file uploads
- Error notification system

### **Worker Pool Monitoring**

- Worker availability status
- Queue length monitoring
- Job distribution metrics

## 🛠️ **Development Guidelines**

### **Adding New Job Types**

1. Update `WorkerJobData` interface in `worker-types.ts`
2. Add case to `executeJob` method in `scraping-worker.ts`
3. Implement handler method in worker class
4. Add route endpoint in appropriate platform directory

### **Route Organization**

- **Shared routes**: Common functionality across platforms
- **Platform routes**: Platform-specific operations
- Follow RESTful conventions
- Include comprehensive Swagger documentation

### **Error Handling**

- Use centralized error handling middleware
- Include proper error logging
- Implement graceful degradation
- Send email notifications for critical errors

## 🔄 **Migration Notes**

This project successfully merges:

- **Expedia manual scraping** (legacy)
- **Expedia GraphQL scraping** (optimized)
- **Agoda scraping** (email-based auth)

All functionality is preserved while providing:

- ✅ Unified worker management
- ✅ Centralized route organization
- ✅ Consistent error handling
- ✅ Comprehensive monitoring
- ✅ Scalable architecture

## 📞 **Support**

For issues or questions regarding the unified scraper system:

1. Check the API documentation at `/api-docs`
2. Review worker pool status at `/api/jobs/worker-pool/status`
3. Monitor job progress via job monitoring endpoints
4. Check application logs for detailed error information
