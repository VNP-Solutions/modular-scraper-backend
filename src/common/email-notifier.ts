import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { JobService } from "../services/job.service.js";
import { dualLogError, dualLogInfo, dualLogWarn } from "./log-helper.js";

dotenv.config();

export interface EmailNotificationData {
  jobId: string;
  jobName?: string;
  propertyName?: string;
  expediaId?: string;
  errorMessage: string;
  errorDetails?: any;
  timestamp: Date;
  stage?: string;
  lastProcessedDate?: string;
  progressPercentage?: number;
}

export class EmailNotifier {
  private static instance: EmailNotifier;
  private transporter: nodemailer.Transporter | null = null;
  private jobService: JobService;

  private constructor() {
    this.jobService = new JobService();
    this.initializeTransporter();
  }

  public static getInstance(): EmailNotifier {
    if (!EmailNotifier.instance) {
      EmailNotifier.instance = new EmailNotifier();
    }
    return EmailNotifier.instance;
  }

  /**
   * Initialize email transporter based on environment configuration
   */
  private async initializeTransporter(): Promise<void> {
    try {
      const emailService = process.env.EMAIL_SERVICE || "gmail";
      const emailUser = process.env.EMAIL_USER;
      const emailPassword = process.env.EMAIL_PASSWORD;
      const smtpHost = process.env.SMTP_HOST;
      const smtpPort = parseInt(process.env.SMTP_PORT || "587");

      if (!emailUser || !emailPassword) {
        await dualLogWarn(
          "Email credentials not configured. Email notifications disabled.",
          {
            emailService,
            hasUser: !!emailUser,
            hasPassword: !!emailPassword,
          }
        );
        return;
      }

      // Configure transporter based on service type
      if (smtpHost) {
        // Custom SMTP configuration
        this.transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465, // true for 465, false for other ports
          auth: {
            user: emailUser,
            pass: emailPassword,
          },
        });
      } else {
        // Use predefined service (Gmail, Outlook, etc.)
        this.transporter = nodemailer.createTransport({
          service: emailService,
          auth: {
            user: emailUser,
            pass: emailPassword,
          },
        });
      }

      // Verify transporter configuration
      if (this.transporter) {
        await this.transporter.verify();
        await dualLogInfo("Email transporter initialized successfully", {
          service: emailService,
          host: smtpHost || `${emailService} service`,
          port: smtpHost ? smtpPort : "default",
        });
      }
    } catch (error) {
      await dualLogError("Failed to initialize email transporter:", error);
      this.transporter = null;
    }
  }

  /**
   * Send error notification to watcher emails for a specific job
   */
  async notifyJobError(
    jobId: string,
    errorMessage: string,
    errorDetails?: any,
    additionalData?: Partial<EmailNotificationData>,
    captchaRecipients?: string[]
  ): Promise<void> {
    try {
      if (!this.transporter) {
        await dualLogWarn(
          "Email transporter not available. Skipping email notification.",
          { jobId, errorMessage }
        );
        return;
      }

      // Get job details including watcher emails
      const job = await this.jobService.getJobById(jobId);
      if (!job) {
        await dualLogWarn(`Job not found for email notification: ${jobId}`, {
          jobId,
        });
        return;
      }

      const watcherEmails = job.watcher_emails || [];

      const captchaEmails = captchaRecipients || [];

      // avoid duplicates
      const recipients = Array.from(
        new Set([...watcherEmails, ...captchaEmails])
      );

      if (recipients.length === 0) {
        await dualLogInfo(
          `No watcher emails configured for job ${jobId}. Skipping notification.`,
          { jobId }
        );
        return;
      }

      // Get property details if available
      let propertyName = job.property_name;
      let expediaId = "";

      if (job.property_id) {
        try {
          const jobWithProperty = await this.jobService.getJobWithProperty(
            jobId
          );
          if (jobWithProperty?.property) {
            expediaId = (jobWithProperty.property as any).expedia_id || "";
          }
        } catch (error) {
          await dualLogWarn("Could not fetch property details for email", {
            jobId,
            error,
          });
        }
      }

      // Prepare notification data
      const notificationData: EmailNotificationData = {
        jobId,
        jobName: job.name || `Job ${jobId}`,
        propertyName,
        expediaId,
        errorMessage,
        errorDetails,
        timestamp: new Date(),
        stage: additionalData?.stage,
        lastProcessedDate: additionalData?.lastProcessedDate,
        progressPercentage: additionalData?.progressPercentage,
      };

      // Send email to all watcher emails
      await this.sendErrorEmail(recipients, notificationData);

      await dualLogInfo(
        `Error notification sent successfully for job ${jobId}`,
        {
          jobId,
          recipientCount: recipients.length,
          recipients: recipients,
        }
      );
    } catch (error) {
      await dualLogError(
        `Failed to send error notification for job ${jobId}:`,
        error,
        { jobId, errorMessage }
      );
    }
  }

  /**
   * Send email to single or multiple recipients
   */
  async sendErrorEmail(
    recipients: string | string[],
    notificationData: EmailNotificationData
  ): Promise<void> {
    if (!this.transporter) {
      throw new Error("Email transporter not initialized");
    }

    const recipientsArray = Array.isArray(recipients)
      ? recipients
      : [recipients];
    const validEmails = this.validateEmails(recipientsArray);

    if (validEmails.length === 0) {
      throw new Error("No valid email addresses provided");
    }

    const subject = this.generateEmailSubject(notificationData);
    const htmlBody = this.generateEmailBody(notificationData);
    const textBody = this.generateTextBody(notificationData);

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: validEmails.join(", "),
      subject,
      text: textBody,
      html: htmlBody,
    };

    await this.transporter.sendMail(mailOptions);
  }

  /**
   * Validate email addresses
   */
  private validateEmails(emails: string[]): string[] {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emails.filter((email) => {
      const isValid = emailRegex.test(email.trim());
      if (!isValid) {
        dualLogWarn(`Invalid email address: ${email}`, { email });
      }
      return isValid;
    });
  }

  /**
   * Generate email subject
   */
  private generateEmailSubject(data: EmailNotificationData): string {
    return `🚨 Scraping Error Alert - ${data.jobName} (${data.jobId})`;
  }

  /**
   * Generate HTML email body
   */
  private generateEmailBody(data: EmailNotificationData): string {
    const formatDate = (date: Date) => {
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
    };

    let errorDetailsSection = '';
    if (data.errorDetails) {
      errorDetailsSection = `
        ${data.errorDetails.sessionUrl ? `
          <tr>
            <th>Session URL</th>
            <td style="word-break: break-all;">
              <a href="${data.errorDetails.sessionUrl}" target="_blank" style="text-decoration: none;">
                ${data.errorDetails.sessionUrl}
              </a>
            </td>
          </tr>
        ` : ''}
        ${data.errorDetails.currentUrl ? `
          <tr>
            <th>Current URL</th>
            <td style="word-break: break-all;">
              <a href="${data.errorDetails.currentUrl}" target="_blank" style="text-decoration: none;">
              ${data.errorDetails.currentUrl}
            </a>
            </td>
          </tr>
        ` : ''}
        ${data.errorDetails.stage ? `
          <tr>
            <th>Stage</th>
            <td>${data.errorDetails.stage}</td>
          </tr>
        ` : ''}
        ${data.errorDetails.instructions ? `
          <tr>
            <th>Instructions</th>
            <td>${data.errorDetails.instructions}</td>
          </tr>
        ` : ''}
      `;
    }

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #dc3545; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
            .content { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 5px 5px; }
            .error-box { background-color: #fff; border-left: 4px solid #dc3545; padding: 15px; margin: 15px 0; }
            .info-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
            .info-table th, .info-table td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
            .info-table th { background-color: #e9ecef; font-weight: bold; }
            .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h2>🚨 Scraping Error Alert</h2>
                <p>A scraping job has encountered an error and requires attention.</p>
            </div>
            <div class="content">
                <div class="error-box">
                    <h3>Error Details</h3>
                    <p><strong>Message:</strong> ${data.errorMessage}</p>
                </div>
                <table class="info-table">
                    ${errorDetailsSection}
                    <tr><th>Job ID</th><td>${data.jobId}</td></tr>
                    <tr><th>Property</th><td>${
                      data.propertyName || "N/A"
                    }</td></tr>
                    <tr><th>Error Time</th><td>${formatDate(
                      data.timestamp
                    )}</td></tr>
                </table>
                ${!data.errorMessage.includes("CAPTCHA") ?
                  `<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 15px 0;">
                      <h4>🔧 Next Steps</h4>
                      <ul>
                          <li>Go to website, and check the job status.</li>
                          <li>Update the Job status to Pending, and change start date and end date also</li>
                          <li>run the job again</li>
                          <li>If the issue persists, please contact the development team.</li>
                      </ul>
                  </div>`
                  : ""
                }
            </div>
            <div class="footer">
                <p>This is an automated notification from the Modular Scraper System.</p>
                <p>Please do not reply to this email.</p>
            </div>
        </div>
    </body>
    </html>
    `;
  }

  /**
   * Generate plain text email body
   */
  private generateTextBody(data: EmailNotificationData): string {
    const formatDate = (date: Date) => {
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
    };

    return `
🚨 SCRAPING ERROR ALERT

A scraping job has encountered an error and requires attention.

ERROR DETAILS:
Message: ${data.errorMessage}

JOB INFORMATION:
- Job ID: ${data.jobId}
- Job Name: ${data.jobName || "N/A"}
- Property: ${data.propertyName || "N/A"}
- Expedia ID: ${data.expediaId || "N/A"}
- Error Time: ${formatDate(data.timestamp)}
${data.stage ? `- Current Stage: ${data.stage}` : ""}
${
  data.lastProcessedDate
    ? `- Last Processed Date: ${data.lastProcessedDate}`
    : ""
}
${
  data.progressPercentage !== undefined
    ? `- Progress: ${data.progressPercentage}%`
    : ""
}

NEXT STEPS:
1. Check the application logs for detailed error information
2. Verify the job configuration and credentials
3. Consider restarting the job if appropriate
4. Contact the development team if the issue persists

---
This is an automated notification from the Modular Scraper System.
Please do not reply to this email.
    `;
  }

  /**
   * Send test email to verify configuration
   */
  async sendTestEmail(recipients: string | string[]): Promise<void> {
    const testData: EmailNotificationData = {
      jobId: "test-job-123",
      jobName: "Test Job",
      propertyName: "Test Property",
      expediaId: "12345",
      errorMessage: "This is a test email to verify email configuration.",
      timestamp: new Date(),
      stage: "testing",
      progressPercentage: 50,
    };

    await this.sendErrorEmail(recipients, testData);
  }
}

// Export singleton instance
export const emailNotifier = EmailNotifier.getInstance();
