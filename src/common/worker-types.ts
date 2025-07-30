export enum JobType {
  PropertyRun = "property-run",
  RerunFailed = "rerun-failed",
  ReservationRun = "reservation-run",
  BookingRun = "booking-run",
  BookingRerunFailed = "booking-rerun-failed",
}

export enum WorkerMessageType {
  JobStart = "job-start",
  JobProgress = "job-progress",
  JobComplete = "job-complete",
  JobError = "job-error",
  JobLog = "job-log",
}
export interface WorkerJobData {
  jobType: JobType;
  jobId: string;
  portfolioId?: string;
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  expediaId?: string;
  bookingId?: string;
  user_email?: string;
  user_password?: string;
  reservations?: any[];
  originalStatus?: string;
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
