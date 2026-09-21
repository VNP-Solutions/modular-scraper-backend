export enum JobType {
  TripPropertyRun = "trip-property-run",
}

export enum WorkerMessageType {
  JobStart = "job-start",
  JobProgress = "job-progress",
  JobComplete = "job-complete",
  JobError = "job-error",
  JobLog = "job-log",
  OtpRelease = "otp-release",
}
export interface WorkerJobData {
  jobType: string;
  jobId: string;
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  user_email?: string;
  user_password?: string;
  /** Trip.com: DB `_id` of the job's property (job's own `property_id`), for job_item persistence. Not the same as `propertyId`, which holds the human-readable property name for TripScraper.searchProperty(). */
  propertyIdForDb?: string;
  /** Trip.com: VCC (virtual card) reveal password, used only if the queried VCC balance is above the processing threshold. */
  tripVccPassword?: string;
  /** Set by worker pool when assigning (e.g. `worker-0`); combined with WORKER_ID for `worker_assigned`. */
  assignedWorkerPoolId?: string;
  [key: string]: any; // Allow additional properties
}

export interface WorkerMessage {
  type: WorkerMessageType;
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
  currentJobType?: string;
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
