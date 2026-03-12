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


export interface PasswordChangeNotificationData {
  jobId: string;
  propertyName: string;
  portfolioName: string;
  newPassword: string;
  timestamp: Date;
  reason?: string;
  username?: string;
  affectedProperties?: Array<{ propertyId: string; propertyName: string }>;
  totalUpdated?: number;
}

export interface BatchPasswordChangeNotificationData {
  jobId: string;
  portfolios: Array<{
    portfolioName: string;
    properties: Array<{
      propertyName: string;
    }>;
  }>;
  newPassword: string;
  timestamp: Date;
  reason?: string;
  totalPropertiesUpdated: number;
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
      }

      const defaultEmail = process.env.EMAIL_USER
        ? [process.env.EMAIL_USER]
        : [];

      const watcherEmails = job?.watcher_emails || [];

      const captchaEmails = captchaRecipients || [];

      // avoid duplicates
      const recipients = Array.from(
        new Set([...watcherEmails, ...captchaEmails, ...defaultEmail])
      );

      if (recipients.length === 0) {
        await dualLogInfo(
          `No watcher emails configured for job ${jobId}. Skipping notification.`,
          { jobId }
        );
        return;
      }

      // Get property details if available
      let propertyName = job?.property_name;
      let expediaId = "";

      if (job?.property_id) {
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
        jobName: job?.name || `Job ${jobId}`,
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
   * Extract plain email from "Display Name <email@domain.com>" or return trimmed address.
   * Returns null if no valid email can be extracted.
   */
  private normalizeEmail(address: string): string | null {
    const trimmed = (address || "").trim();
    if (!trimmed) return null;
    // Angle-bracket format: "Name <email@domain.com>"
    const angleMatch = trimmed.match(/<([^>]+)>/);
    const candidate = angleMatch ? angleMatch[1].trim() : trimmed;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(candidate) ? candidate : null;
  }

  /**
   * Validate email addresses (accepts plain emails and "Display Name <email>" format).
   */
  private validateEmails(emails: string[]): string[] {
    const seen = new Set<string>();
    return emails
      .map((raw) => {
        const normalized = this.normalizeEmail(raw);
        if (normalized == null && (raw || "").trim())
          dualLogWarn(`Invalid or unparseable email address, skipping`, {
            email: raw,
          });
        return normalized;
      })
      .filter((email): email is string => {
        if (email == null) return false;
        if (seen.has(email.toLowerCase())) return false;
        seen.add(email.toLowerCase());
        return true;
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

    let errorDetailsSection = "";
    if (data.errorDetails) {
      errorDetailsSection = `
        ${
          data.errorDetails.sessionUrl
            ? `
          <tr>
            <th style="width: 120px;">Session URL</th>
            <td style="word-break: break-all;">
              <a href="${data.errorDetails.sessionUrl}" target="_blank" style="text-decoration: none;">
                ${data.errorDetails.sessionUrl}
              </a>
            </td>
          </tr>
        `
            : ""
        }
        ${
          data.errorDetails.currentUrl
            ? `
          <tr>
            <th>Current URL</th>
            <td style="word-break: break-all;">
              <a href="${data.errorDetails.currentUrl}" target="_blank" style="text-decoration: none;">
              ${data.errorDetails.currentUrl}
            </a>
            </td>
          </tr>
        `
            : ""
        }
        ${
          data.errorDetails.stage
            ? `
          <tr>
            <th>Stage</th>
            <td>${data.errorDetails.stage}</td>
          </tr>
        `
            : ""
        }
        ${
          data.errorDetails.instructions
            ? `
          <tr>
            <th>Instructions</th>
            <td>${data.errorDetails.instructions}</td>
          </tr>
        `
            : ""
        }
        ${
          data.errorDetails.totalLogEntries
            ? `
          <tr>
            <th>Total log entries</th>
            <td>${data.errorDetails.totalLogEntries}</td>
          </tr>
        `
            : ""
        }
          <tr>
            <th>Log file URL</th>
            <td>${data.errorDetails.logFileUrl || "Not uploaded"}</td>
          </tr>
          <tr>
            <th>Last scraping step URL</th>
            <td>${data.errorDetails.screenshotUrl || "Not uploaded"}</td>
          </tr>
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
                ${
                  !data.errorMessage.includes("CAPTCHA")
                    ? `<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 15px 0;">
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
   * Send password change notification email
   */
  async sendPasswordChangeEmail(
    recipients: string | string[],
    data: PasswordChangeNotificationData
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

    const subject = data.affectedProperties && data.affectedProperties.length > 1
      ? `🔐 Password Changed - ${data.affectedProperties.length} Properties (${data.portfolioName})`
      : `🔐 Password Changed - ${data.propertyName} (${data.portfolioName})`;
    const htmlBody = this.generatePasswordChangeHtmlBody(data);
    const textBody = this.generatePasswordChangeTextBody(data);

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
   * Send batch password change notification email for multiple properties/portfolios
   */
  async sendBatchPasswordChangeEmail(
    recipients: string | string[],
    data: BatchPasswordChangeNotificationData
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

    const subject = `🔐 Password Changed - ${data.totalPropertiesUpdated} Properties Updated`;
    const htmlBody = this.generateBatchPasswordChangeHtmlBody(data);
    const textBody = this.generateBatchPasswordChangeTextBody(data);

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
   * Generate HTML email body for batch password change notification
   */
  private generateBatchPasswordChangeHtmlBody(
    data: BatchPasswordChangeNotificationData
  ): string {
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

    const portfolioList = data.portfolios
      .map(
        (portfolio) =>
          `
                        <div class="portfolio-section">
                            <h4 style="margin: 10px 0 8px 0; color: #007bff;">📁 ${portfolio.portfolioName}</h4>
                            <ul style="margin: 0; padding-left: 20px; line-height: 1.6;">
                                ${portfolio.properties.map((prop) => `<li>${prop.propertyName}</li>`).join("")}
                            </ul>
                        </div>
                    `
      )
      .join("");

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 700px; margin: 0 auto; padding: 20px; }
            .header { background-color: #007bff; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
            .content { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 5px 5px; }
            .info-box { background-color: #fff; border-left: 4px solid #007bff; padding: 15px; margin: 15px 0; }
            .password-box { background-color: #fff3cd; border: 2px solid #ffc107; padding: 15px; margin: 15px 0; border-radius: 5px; }
            .password-value { font-family: 'Courier New', monospace; font-size: 18px; font-weight: bold; color: #d63384; background-color: #f8f9fa; padding: 10px; border-radius: 3px; word-break: break-all; }
            .info-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
            .info-table th, .info-table td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
            .info-table th { background-color: #e9ecef; font-weight: bold; }
            .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
            .warning { background-color: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin: 15px 0; }
            .portfolio-section { margin-bottom: 15px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h2>🔐 Bulk Password Change Notification</h2>
                <p>Passwords have been changed for multiple properties across portfolios.</p>
            </div>
            <div class="content">
                <div class="info-box">
                    <h3>📊 Summary</h3>
                    <table class="info-table">
                        <tr><th>Total Properties Updated</th><td>${data.totalPropertiesUpdated}</td></tr>
                        <tr><th>Total Portfolios Affected</th><td>${data.portfolios.length}</td></tr>
                        <tr><th>Job ID</th><td>${data.jobId}</td></tr>
                        <tr><th>Changed At</th><td>${formatDate(data.timestamp)}</td></tr>
                        ${data.reason ? `<tr><th>Reason</th><td>${data.reason}</td></tr>` : ""}
                    </table>
                </div>

                <div class="info-box">
                    <h3>📑 Affected Portfolios & Properties</h3>
                    ${portfolioList}
                </div>

                <div class="password-box">
                    <h3>🔑 New Password</h3>
                    <p>All properties have been updated with the following password:</p>
                    <div class="password-value">${data.newPassword}</div>
                </div>

                <div class="warning">
                    <h4>📋 Important Notes</h4>
                    <ul>
                        <li>This password change was performed automatically by the scraping system</li>
                        <li>All listed properties now use this password</li>
                        <li>Please update your password manager or secure storage with this new password</li>
                        <li>The old passwords will no longer work for any of these properties</li>
                        <li>Use this password for your next manual login to Booking.com</li>
                    </ul>
                </div>
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
   * Generate plain text email body for batch password change notification
   */
  private generateBatchPasswordChangeTextBody(
    data: BatchPasswordChangeNotificationData
  ): string {
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

    const portfolioList = data.portfolios
      .map(
        (portfolio) =>
          `Portfolio: ${portfolio.portfolioName}\n${portfolio.properties
            .map((prop) => `  - ${prop.propertyName}`)
            .join("\n")}`
      )
      .join("\n\n");

    return `
🔐 BULK PASSWORD CHANGE NOTIFICATION

Passwords have been changed for multiple properties across portfolios.

SUMMARY:
- Total Properties Updated: ${data.totalPropertiesUpdated}
- Total Portfolios Affected: ${data.portfolios.length}
- Job ID: ${data.jobId}
- Changed At: ${formatDate(data.timestamp)}
${data.reason ? `- Reason: ${data.reason}` : ""}

AFFECTED PORTFOLIOS & PROPERTIES:
${portfolioList}

NEW PASSWORD:
${data.newPassword}

IMPORTANT NOTES:
- This password change was performed automatically by the scraping system
- All listed properties now use this password
- Please update your password manager or secure storage with this new password
- The old passwords will no longer work for any of these properties
- Use this password for your next manual login to Booking.com

---
This is an automated notification from the Modular Scraper System.
Please do not reply to this email.
    `;
  }

  /**
   * Generate HTML email body for password change notification
   */
  private generatePasswordChangeHtmlBody(
    data: PasswordChangeNotificationData
  ): string {
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

    // Generate properties list HTML if multiple properties are affected
    const propertiesListHtml = data.affectedProperties && data.affectedProperties.length > 1
      ? `
        <div class="info-box">
          <h3>🏨 Affected Properties (${data.affectedProperties.length})</h3>
          <table class="info-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Property Name</th>
              </tr>
            </thead>
            <tbody>
              ${data.affectedProperties
                .map(
                  (prop, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${prop.propertyName}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `
      : "";

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #007bff; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
            .content { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 5px 5px; }
            .info-box { background-color: #fff; border-left: 4px solid #007bff; padding: 15px; margin: 15px 0; }
            .password-box { background-color: #fff3cd; border: 2px solid #ffc107; padding: 15px; margin: 15px 0; border-radius: 5px; }
            .password-value { font-family: 'Courier New', monospace; font-size: 18px; font-weight: bold; color: #d63384; background-color: #f8f9fa; padding: 10px; border-radius: 3px; word-break: break-all; }
            .info-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
            .info-table th, .info-table td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
            .info-table th { background-color: #e9ecef; font-weight: bold; width: 150px; }
            .info-table thead th { width: auto; }
            .footer { text-align: center; margin-top: 20px; color: #6c757d; font-size: 12px; }
            .warning { background-color: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin: 15px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h2>🔐 Password Change Notification</h2>
                <p>Your Booking.com ${data.affectedProperties && data.affectedProperties.length > 1 ? "properties' passwords have" : "property password has"} been changed automatically.</p>
            </div>
            <div class="content">
                <div class="info-box">
                    <h3>Change Information</h3>
                    <table class="info-table">
                        <tr><th>Property Name</th><td>${
                          data.propertyName
                        }</td></tr>
                        <tr><th>Portfolio Name</th><td>${
                          data.portfolioName
                        }</td></tr>
                        ${
                          data.username
                            ? `<tr><th>Username</th><td>${data.username}</td></tr>`
                            : ""
                        }
                        ${
                          data.totalUpdated
                            ? `<tr><th>Total Properties Updated</th><td><strong>${data.totalUpdated}</strong></td></tr>`
                            : ""
                        }
                        <tr><th>Job ID</th><td>${data.jobId}</td></tr>
                        <tr><th>Changed At</th><td>${formatDate(
                          data.timestamp
                        )}</td></tr>
                        ${
                          data.reason
                            ? `<tr><th>Reason</th><td>${data.reason}</td></tr>`
                            : ""
                        }
                    </table>
                </div>
                ${propertiesListHtml}
                <div class="password-box">
                    <h3>⚠️ New Password</h3>
                    <p>Please save this password securely. You will need it to login to Booking.com:</p>
                    <div class="password-value">${data.newPassword}</div>
                </div>
                <div class="warning">
                    <h4>📋 Important Notes</h4>
                    <ul>
                        <li>This password change was performed automatically by the scraping system</li>
                        ${
                          data.affectedProperties && data.affectedProperties.length > 1
                            ? `<li><strong>All ${data.affectedProperties.length} properties listed above</strong> now share this same password</li>`
                            : ""
                        }
                        <li>Please update your password manager or secure storage with this new password</li>
                        <li>The old password will no longer work for ${data.affectedProperties && data.affectedProperties.length > 1 ? "these properties" : "this property"}</li>
                        <li>Use this password for your next manual login to Booking.com</li>
                    </ul>
                </div>
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
   * Generate plain text email body for password change notification
   */
  private generatePasswordChangeTextBody(
    data: PasswordChangeNotificationData
  ): string {
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

    // Generate properties list text if multiple properties are affected
    const propertiesListText = data.affectedProperties && data.affectedProperties.length > 1
      ? `
AFFECTED PROPERTIES (${data.affectedProperties.length}):
${data.affectedProperties
  .map((prop, index) => `${index + 1}. ${prop.propertyName}`)
  .join("\n")}
`
      : "";

    return `
🔐 PASSWORD CHANGE NOTIFICATION

Your Booking.com ${data.affectedProperties && data.affectedProperties.length > 1 ? "properties' passwords have" : "property password has"} been changed automatically.

CHANGE INFORMATION:
- Property Name: ${data.propertyName}
- Portfolio Name: ${data.portfolioName}
${data.username ? `- Username: ${data.username}` : ""}
${data.totalUpdated ? `- Total Properties Updated: ${data.totalUpdated}` : ""}
- Job ID: ${data.jobId}
- Changed At: ${formatDate(data.timestamp)}
${data.reason ? `- Reason: ${data.reason}` : ""}
${propertiesListText}
NEW PASSWORD:
${data.newPassword}

IMPORTANT NOTES:
- This password change was performed automatically by the scraping system
${data.affectedProperties && data.affectedProperties.length > 1 ? `- All ${data.affectedProperties.length} properties listed above now share this same password` : ""}
- Please update your password manager or secure storage with this new password
- The old password will no longer work for ${data.affectedProperties && data.affectedProperties.length > 1 ? "these properties" : "this property"}
- Use this password for your next manual login to Booking.com

---
This is an automated notification from the Modular Scraper System.
Please do not reply to this email.
    `;
  }

  /**
   * Notify about password change for a specific job
   */
  async notifyPasswordChange(
    jobId: string,
    newPassword: string,
    reason?: string
  ): Promise<void> {
    try {
      if (!this.transporter) {
        await dualLogWarn(
          "Email transporter not available. Skipping password change notification.",
          { jobId }
        );
        return;
      }

      // Get job details
      const job = await this.jobService.getJobById(jobId);
      if (!job) {
        await dualLogWarn(
          `Job not found for password change notification: ${jobId}`,
          { jobId }
        );
        return;
      }

      const defaultEmail = process.env.EMAIL_USER
        ? [process.env.EMAIL_USER]
        : [];
      const watcherEmails = job?.watcher_emails || [];
      const captchaEmails = process.env.CAPTCHA_RECIPIENTS
        ? process.env.CAPTCHA_RECIPIENTS.split(",").map((email) => email.trim())
        : [];

      // Combine all recipients and remove duplicates
      const recipients = Array.from(
        new Set([...watcherEmails, ...captchaEmails, ...defaultEmail])
      );

      if (recipients.length === 0) {
        await dualLogInfo(
          `No recipients configured for password change notification for job ${jobId}. Skipping.`,
          { jobId }
        );
        return;
      }

      // Prepare notification data
      const notificationData: PasswordChangeNotificationData = {
        jobId,
        propertyName: job.property_name || "Unknown Property",
        portfolioName: job.portfolio_name || "Unknown Portfolio",
        newPassword,
        timestamp: new Date(),
        reason,
      };

      // Send email to all recipients
      await this.sendPasswordChangeEmail(recipients, notificationData);

      await dualLogInfo(
        `Password change notification sent successfully for job ${jobId}`,
        {
          jobId,
          recipientCount: recipients.length,
          recipients: recipients,
        }
      );
    } catch (error) {
      await dualLogError(
        `Failed to send password change notification for job ${jobId}:`,
        error,
        { jobId }
      );
    }
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
