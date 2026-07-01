export interface WorkerJobData {
  jobType: "agoda-property-run" | "agoda-check-properties" | "stop";
  jobId: string;
  startDate?: string;
  endDate?: string;
  agodaId?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  agoda_ids?: Array<{ _id: string; agoda_id: string | number }>;
  brightDataSessionId?: string;
  windowSize?: { width: number; height: number };
  timezone?: string;
  acceptLanguage?: string;
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
