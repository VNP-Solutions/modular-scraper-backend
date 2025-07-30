import express from 'express';
import { mainMultiPlatform, SupportedPlatforms } from '../main-multi-platform.js';

const router = express.Router();

interface ScrapingRequest {
  platform: SupportedPlatforms | string;
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  jobId?: string;
  credentials: {
    email: string;
    password: string;
  };
  url?: string;
}

// POST /api/scrape/multi-platform
router.post('/multi-platform', (async (req: express.Request, res: express.Response) => {
  try {
    const {
      platform,
      propertyId,
      startDate,
      endDate,
      jobId,
      credentials,
      url
    }: ScrapingRequest = req.body;

    // Validate required fields
    if (!credentials?.email || !credentials?.password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required in credentials object'
      });
    }

    if (!platform && !url) {
      return res.status(400).json({
        success: false,
        error: 'Either platform or url must be specified'
      });
    }

    // Generate job ID if not provided
    const finalJobId = jobId || `scraping-${platform || 'auto'}-${Date.now()}`;

    console.log(`🚀 Starting multi-platform scraping job: ${finalJobId}`);

    // Execute scraping asynchronously
    const scrapingPromise = mainMultiPlatform({
      platform,
      propertyId,
      startDate,
      endDate,
      jobId: finalJobId,
      user_email: credentials.email,
      user_password: credentials.password, // Note: In production this should be encrypted
      url
    });

    // Return immediate response with job ID
    res.json({
      success: true,
      message: 'Scraping job started',
      jobId: finalJobId,
      platform: platform || 'auto-detected',
      timestamp: new Date().toISOString()
    });

    // Handle the scraping result asynchronously
    try {
      await scrapingPromise;
      console.log(`✅ Scraping job ${finalJobId} completed successfully`);
    } catch (error) {
      console.error(`❌ Scraping job ${finalJobId} failed:`, error);
    }

  } catch (error) {
    console.error('Multi-platform scraping API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}) as any);

// GET /api/scrape/platforms
router.get('/platforms', (req: express.Request, res: express.Response) => {
  try {
    const supportedPlatforms = Object.values(SupportedPlatforms);
    
    res.json({
      success: true,
      platforms: supportedPlatforms,
      count: supportedPlatforms.length,
      details: {
        [SupportedPlatforms.EXPEDIA]: {
          name: 'Expedia Partner Central',
          url: 'https://www.expediapartnercentral.com',
          features: ['Property Search', 'Date Range Selection', '2FA/OTP Support']
        },
        [SupportedPlatforms.BOOKING]: {
          name: 'Booking.com Admin Portal',
          url: 'https://admin.booking.com',
          features: ['Captcha Handling', '2FA Support', 'Browserless UI Access']
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve platforms'
    });
  }
});

// GET /api/scrape/test/booking
router.get('/test/booking', (async (req: express.Request, res: express.Response) => {
  try {
    const { email, password } = req.query;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password query parameters are required for testing'
      });
    }

    const testJobId = `booking-test-${Date.now()}`;
    
    // Start test scraping job
    const testPromise = mainMultiPlatform({
      platform: SupportedPlatforms.BOOKING,
      propertyId: 'test-property',
      jobId: testJobId,
      user_email: email as string,
      user_password: password as string
    });

    res.json({
      success: true,
      message: 'Booking.com test started',
      jobId: testJobId,
      testUrl: `Check logs for job ${testJobId}`
    });

    // Handle test result
    try {
      await testPromise;
      console.log(`✅ Booking.com test ${testJobId} completed`);
    } catch (error) {
      console.error(`❌ Booking.com test ${testJobId} failed:`, error);
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}) as any);

export default router;