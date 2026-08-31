export interface WorkerJobData {
  jobType:
    | "property-run"
    | "rerun-failed"
    | "reservation-run"
    | "graphql-run"
    | "agoda-property-run"
    | "agoda-rerun-failed"
    | "agoda-reopen-case"
    | "stop";
  jobId: string;
  startDate?: string;
  endDate?: string;
  expediaId?: string;
  user_email?: string;
  user_password?: string;
  agodaId?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  reservations?: any[];
  originalStatus?: string;
  /** Bookings the reopen rules flagged; used by `agoda-reopen-case` jobs. */
  reopenBookingIds?: string[];
  /** Case ID from the Partner Support reply, quoted back in the new request. */
  caseId?: string | null;
  // Bright Data isolation config
  brightDataSessionId?: string; // Session ID for Bright Data proxy
  windowSize?: { width: number; height: number }; // Window size for browser
  timezone?: string; // Timezone for browser emulation
  acceptLanguage?: string; // Accept-Language header for browser
}

export interface WorkerMessage {
  type: "job-start" | "job-progress" | "job-complete" | "job-error" | "job-log";
  data: any;
  jobId: string;
  timestamp: Date;
}

export interface WorkerResponse {
  success: boolean;
  data?: any;
  error?: string;
  jobId: string;
  finalStatus?: string;
  progress?: any;
  logInfo?: any;
}

export interface WorkerPoolConfig {
  maxWorkers: number;
  queueSize: number;
}

export interface WorkerInfo {
  id: string;
  isAvailable: boolean;
  currentJobId?: string;
  startTime?: Date;
  lastActivity?: Date;
}

export interface WorkerPoolStatus {
  totalWorkers: number;
  availableWorkers: number;
  busyWorkers: number;
  queuedJobs: number;
  workers: WorkerInfo[];
}
