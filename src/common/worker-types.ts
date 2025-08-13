export interface WorkerJobData {
  jobType: "agoda-property-run" | "agoda-rerun-failed";
  jobId: string;
  startDate?: string;
  endDate?: string;
  agodaId?: string;
  agodaUsername?: string;
  agodaPassword?: string;
  originalStatus?: string; // For rerun operations
}

export interface WorkerMessage {
  type: "job-start" | "job-progress" | "job-complete" | "job-error" | "job-log";
  jobId: string;
  data?: any;
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

export interface WorkerInfo {
  id: string;
  isAvailable: boolean;
  lastActivity: Date;
  currentJobId?: string;
  startTime?: Date;
}

export interface WorkerPoolConfig {
  maxWorkers: number;
  queueSize: number;
}

export interface WorkerPoolStatus {
  totalWorkers: number;
  availableWorkers: number;
  busyWorkers: number;
  queuedJobs: number;
  workers: WorkerInfo[];
}
