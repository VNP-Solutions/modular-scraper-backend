# Agoda Integration Guide

This document outlines the Agoda functionality that has been integrated into the modular-scraper-backend_old project.

## ✅ Integration Complete

The old project now supports **both Expedia and Agoda** scraping using the same unified worker thread system.

## 🚀 What's New

### **1. Enhanced Data Models**

#### Property Model Updates

- Added `agoda_id` field with validation (cannot be "0" or empty)
- Both `expedia_id` and `agoda_id` are now required and unique

#### Job Model Updates

- Added `case_open` boolean field for tracking support case status

#### New Property Credentials Model

- Centralized credential management per property
- Supports both platforms: `expediaUsername/Password` and `agodaUsername/Password`
- Replaces legacy inline credential storage

### **2. Services & Infrastructure**

#### Property Credentials Service

```typescript
await propertyCredentialsService.getCredentialsByJobId(jobId);
await propertyCredentialsService.upsertCredentials(propertyId, credentials);
```

#### Job Service Extensions

```typescript
await jobService.getAgodaIdFromJob(jobId);
await jobService.updateJobCaseOpen(jobId, true);
```

#### Email Notification System

- Multi-provider email support (Gmail, Outlook, SMTP)
- Automatic error notifications for job failures
- HTML/text dual-format emails with job context

### **3. Unified Worker Thread System**

The worker now handles both platforms seamlessly:

```typescript
// Worker automatically routes based on job type:
switch (jobData.jobType) {
  case "property-run": // → Expedia handler
  case "rerun-failed": // → Expedia handler
  case "agoda-property-run": // → NEW Agoda handler
  case "agoda-rerun-failed": // → NEW Agoda rerun handler
  // ... other job types
}
```

### **4. Complete Agoda Automation**

#### Login System (`src/agoda/login-system/`)

- **Email Link Authentication**: Automatically extracts sign-in links from Gmail
- **OTP Support**: Handles 6-digit PIN codes sent via email
- **Dual Flow Support**: Adapts to both direct links and OTP forms
- **Gmail Integration**: Uses Google APIs for email access

#### Booking Data Retrieval (`src/agoda/booking-data/`)

- **CSV Download**: Automated CSV file download from Agoda YCS
- **Data Processing**: Parses and validates booking records
- **Database Storage**: Maps CSV data to JobItem records
- **Export Functionality**: Creates formatted export CSV files

#### Need Help Automation (`src/agoda/need-help/`)

- **Support Ticket Creation**: Automates the entire support form process
- **File Upload**: Attaches CSV files to support requests
- **Form Filling**: Automatically fills issue details and phone numbers
- **Cleanup**: Removes temporary files after successful submission

### **5. New API Endpoints**

The app now includes Agoda-specific endpoints:

```bash
# Start Agoda property scraping job
POST /api/agoda/property-run-job
{
  "startDate": "01/01/2025",
  "endDate": "01/31/2025",
  "jobId": "6892f4bf9df8bc296bdcdff0"
}

# Rerun failed/partial Agoda job
POST /api/agoda/rerun-failed-job
{
  "jobId": "6892f4bf9df8bc296bdcdff0"
}
```

## 🔧 Configuration

### Required Environment Variables

```env
# Google OAuth (for Gmail API access)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
TOKEN_PATH=token.json

# Email Notifications
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=your-email@gmail.com

# AWS S3 (for log storage)
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_S3_BUCKET_NAME=your-s3-bucket-name
AWS_S3_REGION=us-east-1
```

### Database Setup

Ensure your Property documents have both platform IDs:

```javascript
{
  expedia_id: "12345",
  agoda_id: "67890",
  property_name: "Sample Hotel",
  // ... other fields
}
```

Create Property Credentials documents:

```javascript
{
  property_id: ObjectId("..."),
  expediaUsername: "expedia@email.com",
  expediaPassword: "password123",
  agodaUsername: "agoda@email.com",
  agodaPassword: "password456"
}
```

## 🎯 Key Features

### **Parallel Processing**

- Single worker pool handles both Expedia and Agoda jobs
- Configurable worker threads (default: 3)
- Queue management with busy server responses

### **Email-Based Authentication**

- Automatic Gmail sign-in link extraction
- OTP code parsing from email content
- Robust retry mechanisms with multiple attempts

### **Comprehensive Error Handling**

- Email notifications on job failures
- Automatic job status updates
- Progress tracking and resume capability
- Browser resource cleanup

### **CSV Processing**

- Download → Parse → Validate → Store → Export pipeline
- Handles multi-line CSV fields properly
- Automatic file cleanup after processing

### **Support Automation**

- Automated support ticket creation
- File attachment handling
- Form field population
- Case tracking with `case_open` field

## 🔄 Migration from Legacy System

The integration maintains **backward compatibility**:

1. **Existing Expedia jobs** continue to work unchanged
2. **Property credentials** are migrated to the new centralized model
3. **Worker threads** handle both platforms transparently
4. **API endpoints** follow the same patterns

## 🧪 Testing the Integration

### 1. Test Worker Pool Status

```bash
GET /api/worker-pool/status
```

### 2. Test Expedia Job (existing functionality)

```bash
POST /api/expedia/property-run-job
{
  "startDate": "01/01/2025",
  "endDate": "01/31/2025",
  "jobId": "your-expedia-job-id"
}
```

### 3. Test Agoda Job (new functionality)

```bash
POST /api/agoda/property-run-job
{
  "startDate": "01/01/2025",
  "endDate": "01/31/2025",
  "jobId": "your-agoda-job-id"
}
```

### 4. Verify Dual Platform Support

Both platforms can run simultaneously using the same worker infrastructure.

## 📋 Pre-Integration Checklist

- [ ] MongoDB database with Property and Job collections
- [ ] Google OAuth credentials configured
- [ ] Gmail API enabled and token.json generated
- [ ] Property records with both `expedia_id` and `agoda_id`
- [ ] Property credentials created for target properties
- [ ] Environment variables configured
- [ ] Worker thread pool configured (MAX_WORKER_THREADS)

## 🎉 Success Indicators

- ✅ Both platform APIs respond correctly
- ✅ Worker pool shows available/busy workers
- ✅ Gmail integration extracts sign-in links
- ✅ CSV files download and process correctly
- ✅ Job status updates reflect progress
- ✅ Email notifications sent on failures
- ✅ Support tickets created successfully

The integration is now **complete** and ready for production use with both Expedia and Agoda platforms!
