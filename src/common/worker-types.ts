export interface WorkerJobData {
  jobType:
    | "property-run"
    | "rerun-failed"
    | "reservation-run"
    | "graphql-run"
    | "agoda-property-run"
    | "agoda-rerun-failed";
  jobId: string;
  startDate?: string;
  endDate?: string;
  expediaId?: string;
  agodaId?: string;
  user_email?: string;
  user_password?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  reservations?: any[];
  originalStatus?: string;
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
