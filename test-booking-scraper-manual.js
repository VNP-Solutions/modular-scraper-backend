#!/usr/bin/env node

import { BookingScraper } from './dist/scrapers/booking-scraper.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testBookingScraperManual() {
  console.log('🧪 Manual Testing of Booking.com Scraper\n');
  
  const scraper = new BookingScraper();
  
  try {
    // Test 1: Basic Setup and Login
    console.log('📋 Test 1: Setup Browser and Login');
    console.log('=====================================');
    
    const email = process.env.BOOKING_EMAIL;
    const password = process.env.BOOKING_PASSWORD;
    const propertyId = process.env.PROPERTY_ID;
    
    if (!email || !password) {
      console.log('❌ Please set BOOKING_EMAIL and BOOKING_PASSWORD in your .env file');
      return;
    }
    
    console.log(`📧 Using email: ${email}`);
    console.log('🔑 Password: [hidden]');
    
    // Execute the complete scraping process
    const result = await scraper.executeScraping({
      jobId: '6880f842e233aea1c06d2d3c',
      propertyId: propertyId,
      credentials: { email, password },
    });
    
    console.log('\n📊 Test Results:');
    console.log('================');
    console.log(`✅ Success: ${result.success}`);
    
    if (result.success && result.data) {
      console.log(`📈 Navigation Success: ${result.data.navigation.vccsManagement}`);
      console.log(`🔗 View All Button: ${result.data.navigation.viewAllButton}`);
      console.log(`📄 Processed Reservations: ${result.data.traversal.processed}`);
      console.log(`❌ Errors: ${result.data.traversal.errors}`);
      console.log(`📊 Success Rate: ${result.data.traversal.successRate}%`);
      console.log(`📸 Screenshots: ${result.data.screenshots.length} taken`);
    } else {
      console.log(`❌ Error: ${result.error}`);
    }
    
    console.log('\n🎉 Manual test completed!');
    console.log('📁 Check the screenshots folder for visual verification');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Run the test
testBookingScraperManual().catch(console.error);