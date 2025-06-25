export interface ScrapingState {
  isRunning: boolean;
  isPaused: boolean;
  currentPropertyId?: string;
  currentJobId?: string;
  startDate?: string;
  endDate?: string;
  currentPage?: number;
  totalPages?: number;
  processedCount?: number;
  totalCount?: number;
  lastUpdated: Date;
}

class ScrapingStateManager {
  private state: ScrapingState = {
    isRunning: false,
    isPaused: false,
    lastUpdated: new Date(),
  };

  private onStateChangeCallbacks: Array<(state: ScrapingState) => void> = [];

  getState(): ScrapingState {
    return { ...this.state };
  }

  startScraping(
    propertyId: string,
    jobId: string,
    startDate?: string,
    endDate?: string
  ): void {
    this.state = {
      isRunning: true,
      isPaused: false,
      currentPropertyId: propertyId,
      currentJobId: jobId,
      startDate,
      endDate,
      lastUpdated: new Date(),
    };
    this.notifyStateChange();
  }

  pauseScraping(): boolean {
    if (!this.state.isRunning) {
      return false;
    }
    this.state.isPaused = true;
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
    return true;
  }

  resumeScraping(): boolean {
    if (!this.state.isRunning || !this.state.isPaused) {
      return false;
    }
    this.state.isPaused = false;
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
    return true;
  }

  stopScraping(): void {
    this.state = {
      isRunning: false,
      isPaused: false,
      lastUpdated: new Date(),
    };
    this.notifyStateChange();
  }

  updateProgress(
    currentPage?: number,
    totalPages?: number,
    processedCount?: number,
    totalCount?: number
  ): void {
    this.state.currentPage = currentPage;
    this.state.totalPages = totalPages;
    this.state.processedCount = processedCount;
    this.state.totalCount = totalCount;
    this.state.lastUpdated = new Date();
    this.notifyStateChange();
  }

  isPaused(): boolean {
    return this.state.isPaused;
  }

  isRunning(): boolean {
    return this.state.isRunning;
  }

  onStateChange(callback: (state: ScrapingState) => void): void {
    this.onStateChangeCallbacks.push(callback);
  }

  private notifyStateChange(): void {
    this.onStateChangeCallbacks.forEach((callback) => {
      try {
        callback(this.state);
      } catch (error) {
        console.error("Error in state change callback:", error);
      }
    });
  }

  // Utility method to wait while paused
  async waitWhilePaused(): Promise<void> {
    while (this.state.isPaused && this.state.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Export singleton instance
export const scrapingStateManager = new ScrapingStateManager();
