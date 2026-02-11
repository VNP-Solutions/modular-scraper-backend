# Complete Agoda Retrieval Flow - Email Button Click in Iframe

## 🎯 Overview
This document explains the complete flow of the Agoda booking data retrieval process, focusing on how the system handles OTP verification via email when the verification form appears inside an iframe.

---

## 📋 Complete Flow (Step-by-Step)

### **Phase 1: Initialization**
```
Entry Point: agodaRetrieval() function
↓
1. User provides:
   - Booking ID(s) to retrieve
   - Agoda username (email)
   - Agoda password
   - Job ID
```

### **Phase 2: Browser Setup & Login**
```
2. Browser Setup
   ├─ Launch browser (local or production)
   └─ Navigate to Agoda YCS portal

3. Login Process
   ├─ Enter username (email)
   ├─ Enter password
   ├─ Handle login OTP (if required)
   └─ Successfully logged in to YCS portal
```

### **Phase 3: Search for Booking**
```
4. Navigate to Reservations Page
   ├─ URL: https://ycs.agoda.com/mldc/en-us/app/reservations/...
   └─ Page shows list of all bookings

5. Search for Specific Booking ID
   ├─ Find search input: [data-cy="booking-search-input"]
   ├─ Clear any existing text
   ├─ Type booking ID (e.g., "12345678")
   ├─ Click Search button
   └─ Wait for results
```

### **Phase 4: Open Booking Details**
```
6. Click on Booking Row
   ├─ Find row with booking ID
   ├─ Click on guest name or booking row
   └─ Right sidebar opens with booking details

7. Sidebar Appears
   ├─ Shows tabs: Overview, Payment, Get payout (UPC), etc.
   └─ Ready to navigate to payout tab
```

### **Phase 5: Click "Get Payout (UPC)" Tab** ⭐
```
8. Click "Get payout (UPC)" Tab
   ├─ Selector: [data-testid="payout-tab"]
   ├─ Click the tab
   └─ Wait for content to load
```

**🔥 Critical Point: After clicking payout tab, one of two things happens:**

---

## 🔀 Two Possible Scenarios

### **Scenario A: No OTP Required (Direct UPC Card Display)**
```
After clicking payout tab:
├─ UPC widget appears immediately
├─ Shows card details:
│   ├─ Card Holder Name
│   ├─ Card Number
│   ├─ Expiration Date
│   └─ CVC Code
└─ Scrape data and done! ✅
```

### **Scenario B: OTP Verification Required (Iframe Appears)** 🎯
**This is where the email button click happens!**

---

## 🎯 Detailed Flow for Scenario B (OTP in Iframe)

### **Step 1: Iframe Detection** 🔍
```
After clicking payout tab:
↓
Wait 5 seconds for page to load
↓
Check: Does page have iframe?
├─ Look for: iframe[data-cy="ul-app-frame"]
├─ Iframe structure:
│   <iframe 
│     src="/en-us/ul/login?appId=ycs&initialPath=verifyOtp"
│     data-cy="ul-app-frame"
│     title="Universal login">
│     
│     <!-- Inside iframe DOM: -->
│     <div data-cy="verify-otp-panel">
│       <h3>Please verify your identity</h3>
│       <div data-cy="otp-option-email">via Email</div>
│       <div data-cy="otp-option-phone">via Text message (SMS)</div>
│     </div>
│   </iframe>
└─ Iframe detected! ✅
```

**Code at this point:**
```typescript
// Check all frames on the page
const iframes = await page.frames();
let otpFrame = null;

for (const frame of iframes) {
  const frameUrl = frame.url();
  
  // Check if this frame has OTP elements
  const hasOtpForm = await frame.evaluate(() => {
    return {
      hasEmailOption: !!document.querySelector('[data-cy="otp-option-email"]'),
      hasVerifyPanel: !!document.querySelector('[data-cy="verify-otp-panel"]'),
      // ... other checks
    };
  });
  
  if (hasOtpForm.hasEmailOption || hasOtpForm.hasVerifyPanel) {
    otpFrame = frame;  // ✅ Found the iframe!
    break;
  }
}
```

### **Step 2: Enter Iframe Context** 🚪
```
otpFrame found!
↓
Set targetPage = otpFrame
↓
Now ALL operations use iframe context:
├─ targetPage.click() → clicks INSIDE iframe
├─ targetPage.waitForSelector() → waits INSIDE iframe
└─ targetPage.evaluate() → runs code INSIDE iframe
```

### **Step 3: Check What's Inside Iframe** 🔍
```
Inside iframe, check for elements:
↓
await targetPage.evaluate(() => {
  return {
    hasVerifyOtpPanel: !!document.querySelector('[data-cy="verify-otp-panel"]'),
    hasEmailOption: !!document.querySelector('[data-cy="otp-option-email"]'),
    hasSmsOption: !!document.querySelector('[data-cy="otp-option-phone"]'),
    hasOtpInputs: !!document.querySelector('[data-cy="otp-0"]'),
    bodyText: document.body.textContent.substring(0, 200)
  };
});
↓
Result:
✅ hasVerifyOtpPanel: true
✅ hasEmailOption: true
✅ hasSmsOption: true
❌ hasOtpInputs: false (not visible yet)
```

### **Step 4: Click "via Email" Button** 🖱️
**This is the critical step!**

```
Try multiple selectors (inside iframe):
├─ [data-cy="otp-option-email"]  ← Primary selector
├─ [data-cy="email-option"]
├─ div[data-cy="otp-option-email"]
├─ button with text "via Email"
└─ span with text "via Email"

For each selector:
  1. Wait for element (timeout: 5 seconds)
     await targetPage.waitForSelector(selector, { visible: true, timeout: 5000 });
     
  2. Try Method 1: Regular click
     try {
       await targetPage.click(selector);
       ✅ Success!
     }
     
  3. If Method 1 fails, try Method 2: JavaScript click
     await targetPage.evaluate((sel) => {
       const element = document.querySelector(sel);
       element.click();  // Direct click
       element.parentElement?.click();  // Parent click
       
       // Dispatch mouse events
       element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
     }, selector);
     ✅ Success!
     
  4. Wait 3 seconds for form transition
     await delay(3000);
     
  5. Break (selector worked!)
```

**What happens after clicking "via Email":**
```
Click "via Email" inside iframe
↓
Iframe content changes:
├─ "via Email" option disappears
├─ "via SMS" option disappears
└─ OTP input form appears!

New iframe content:
<div data-cy="verify-otp-panel">
  <p>OTP has been sent to chartwell@epchotels.com</p>
  <span data-cy="otp-refcode">Refcode: ABC123</span>
  
  <!-- 6 OTP input boxes -->
  <input data-cy="otp-0" />
  <input data-cy="otp-1" />
  <input data-cy="otp-2" />
  <input data-cy="otp-3" />
  <input data-cy="otp-4" />
  <input data-cy="otp-5" />
  
  <button data-cy="submit-otp-button">Submit OTP</button>
</div>
```

### **Step 5: Wait for OTP Input Form** ⏱️
```
After clicking email option:
↓
Wait for OTP inputs to appear (inside iframe):
await targetPage.waitForSelector('[data-cy="otp-0"]', { 
  visible: true, 
  timeout: 30000 
});
↓
If found: ✅ OTP input form appeared!
If not found: ❌ Error (email click may have failed)
```

### **Step 6: Extract Email Address from Iframe** 📧
```
Extract recipient email from iframe:
↓
await targetPage.evaluate(() => {
  // Find text: "OTP has been sent to chartwell@epchotels.com"
  const spans = document.querySelectorAll('span');
  for (const span of spans) {
    const text = span.textContent;
    if (text.includes('OTP has been sent to')) {
      // Extract email using regex
      const match = text.match(/OTP has been sent to\s+([^\s]+@[^\s]+)/);
      return match[1]; // "chartwell@epchotels.com"
    }
  }
});
↓
Email extracted: "chartwell@epchotels.com"
```

### **Step 7: Wait for Email to Arrive** 📬
```
Wait 60 seconds for OTP email:
await delay(60000);
↓
This gives Agoda time to send the email
```

### **Step 8: Fetch OTP from Gmail** 📧
```
Use Gmail API to fetch OTP:
↓
Search query: 
  "from:no-reply@account.agoda.com 
   subject:'One-time passcode for YCS login' 
   to:chartwell@epchotels.com"
↓
Get newest email
↓
Extract 6-digit OTP code from email body:
├─ Pattern 1: "Your one-time PIN code is: 123456"
├─ Pattern 2: "Your PIN code for YCS login ... 123456"
└─ Pattern 3: Standalone 6 digits

OTP found: "123456"
```

### **Step 9: Fill OTP Inputs (Inside Iframe)** ⌨️
```
Split OTP into digits: ["1", "2", "3", "4", "5", "6"]
↓
For each digit (i = 0 to 5):
  1. Find input: [data-cy="otp-{i}"]  (inside iframe)
     await targetPage.waitForSelector(`[data-cy="otp-${i}"]`);
  
  2. Focus input
     await targetPage.focus(`[data-cy="otp-${i}"]`);
  
  3. Clear any existing value
     await targetPage.evaluate((selector) => {
       document.querySelector(selector).value = '';
     }, selector);
  
  4. Type digit
     await targetPage.type(`[data-cy="otp-${i}"]`, digit, { delay: 150 });
  
  5. Move to next input

All 6 digits filled! ✅
```

### **Step 10: Submit OTP (Inside Iframe)** ✉️
```
Find Submit button (inside iframe):
await targetPage.waitForSelector('[data-cy="submit-otp-button"]', {
  visible: true,
  timeout: 30000
});
↓
Wait for button to be enabled:
await targetPage.waitForFunction(() => {
  const button = document.querySelector('[data-cy="submit-otp-button"]');
  return button && !button.disabled;
});
↓
Click Submit button:
await targetPage.click('[data-cy="submit-otp-button"]');
↓
Wait for submission:
await delay(3000);
↓
✅ OTP submitted successfully!
```

### **Step 11: Iframe Closes / UPC Widget Appears** 🎉
```
After successful OTP submission:
↓
Iframe disappears or redirects
↓
Main page updates:
├─ Sidebar refreshes
└─ UPC widget appears!

<div data-testid="ycs-upc-widget">
  <div data-testid="card-holder-name-value">
    <p>JOHN DOE</p>
  </div>
  <div data-testid="card-number-value">
    <p>4111 1111 1111 1111</p>
  </div>
  <div data-testid="card-expiration-date-value">
    <p>2026/12</p>
  </div>
  <div data-testid="card-cvc-code-value">
    <p>123</p>
  </div>
</div>
```

### **Step 12: Re-Search and Navigate Back to Payout** 🔄
```
After OTP verification:
↓
Need to re-open booking details:
├─ Search for same booking ID again
├─ Click booking row
├─ Click "Get payout (UPC)" tab again
└─ Now UPC widget should appear (no OTP this time!)
```

### **Step 13: Scrape UPC Card Data** 💳
```
Scrape card details from UPC widget:
↓
await page.evaluate(() => {
  return {
    cardHolderName: document.querySelector('[data-testid="card-holder-name-value"] p')?.textContent,
    cardNumber: document.querySelector('[data-testid="card-number-value"] p')?.textContent,
    expirationDate: document.querySelector('[data-testid="card-expiration-date-value"] p')?.textContent,
    cvcCode: document.querySelector('[data-testid="card-cvc-code-value"] p')?.textContent,
  };
});
↓
Result:
{
  cardHolderName: "JOHN DOE",
  cardNumber: "4111 1111 1111 1111",
  expirationDate: "2026/12",
  cvcCode: "123"
}
```

### **Step 14: Save to Database** 💾
```
Save card info to database:
↓
await retrievalService.updateRetrievalItemCardInfo(
  retrievalId,
  bookingId,
  {
    card_number: "4111111111111111",
    expiry_date: "12/26",  // Formatted from "2026/12"
    cvv: "123",
    reason_for_charge: "JOHN DOE"
  }
);
↓
✅ Card info saved!
```

### **Step 15: Complete** ✅
```
Process complete for this booking ID!
↓
If more booking IDs to process:
  └─ Repeat from Step 5 (search next booking ID)
↓
If all booking IDs processed:
  └─ Job complete! 🎉
```

---

## 🎯 Key Points About the Flow

### **Why the Iframe Fix Was Critical:**

**Before Fix:**
```
targetPage = page  (always main page)
↓
await page.click('[data-cy="otp-option-email"]')
↓
❌ Element not found on main page
❌ Click fails
❌ OTP form never appears
```

**After Fix:**
```
targetPage = otpFrame  (iframe when detected)
↓
await otpFrame.click('[data-cy="otp-option-email"]')
↓
✅ Element found INSIDE iframe
✅ Click succeeds
✅ OTP form appears
✅ Process continues
```

---

## 📊 Visual Flow Diagram

```
User Request
    ↓
Browser Setup → Login → Navigate to Reservations
    ↓
Search Booking ID → Click Booking Row → Sidebar Opens
    ↓
Click "Get payout (UPC)" Tab
    ↓
    ├─────────────────┬─────────────────┐
    ↓                 ↓                 ↓
No OTP Required   Iframe Appears    Main Page OTP
    ↓                 ↓                 ↓
UPC Widget      Detect Iframe      Detect OTP Form
    ↓                 ↓                 ↓
Scrape Data     Enter Iframe      Click Email Option
    ↓             Context              ↓
    ↓                 ↓            Wait for Form
    ↓           Check Elements         ↓
    ↓                 ↓            Fetch OTP Email
    ↓           Click "via Email"      ↓
    ↓                 ↓            Fill OTP Inputs
    ↓           Wait for Form          ↓
    ↓                 ↓            Submit OTP
    ↓           Extract Email          ↓
    ↓                 ↓                 ↓
    ↓           Wait 60 seconds        ↓
    ↓                 ↓                 ↓
    ↓           Fetch OTP from Gmail   ↓
    ↓                 ↓                 ↓
    ↓           Fill 6 OTP Inputs      ↓
    ↓                 ↓                 ↓
    ↓           Submit OTP             ↓
    ↓                 ↓                 ↓
    └─────────────────┴─────────────────┘
                      ↓
              Iframe Closes
                      ↓
              Re-search Booking
                      ↓
              Click Payout Tab
                      ↓
              UPC Widget Appears
                      ↓
              Scrape Card Data
                      ↓
              Save to Database
                      ↓
                 Complete! ✅
```

---

## 🔧 Technical Implementation Details

### **1. Iframe Detection (Lines ~253-340)**
```typescript
// Check if Universal Login iframe exists
const hasUniversalLoginIframe = await page.evaluate(() => {
  return !!document.querySelector('iframe[data-cy="ul-app-frame"]');
});

// Get all frames
const iframes = await page.frames();

// Check each frame for OTP elements
for (const frame of iframes) {
  const hasOtpForm = await frame.evaluate(() => {
    return {
      hasEmailOption: !!document.querySelector('[data-cy="otp-option-email"]'),
      hasVerifyPanel: !!document.querySelector('[data-cy="verify-otp-panel"]'),
      // ...
    };
  });
  
  if (hasOtpForm.hasEmailOption) {
    otpFrame = frame;  // Found it!
    break;
  }
}
```

### **2. Context Switch (Line ~722)**
```typescript
const targetPage = frame || page;
// If frame exists, ALL operations use iframe
// If no frame, operations use main page
```

### **3. Email Button Click (Lines ~795-865)**
```typescript
const emailOptionSelectors = [
  '[data-cy="otp-option-email"]',
  'div[data-cy="otp-option-email"]',
  // ... more selectors
];

for (const selector of emailOptionSelectors) {
  try {
    // Wait for element in iframe/page
    await targetPage.waitForSelector(selector, {
      visible: true,
      timeout: 5000,
    });
    
    // Try regular click
    await targetPage.click(selector);
    
    // Wait for form transition
    await delay(3000);
    break;
  } catch {
    // Try next selector
    continue;
  }
}
```

### **4. OTP Email Retrieval (Lines ~1000-1050)**
```typescript
// Fetch OTP from Gmail
const otpResult = await getYcsRetrievalOtpCode(
  recipientEmail,
  10,  // Check last 10 emails
  referenceCode
);

// otpResult = { otpCode: "123456", emailFound: true }
```

### **5. Fill OTP Inputs (Lines ~1055-1100)**
```typescript
const otpDigits = otpResult.otpCode.split("");  // ["1","2","3","4","5","6"]

for (let i = 0; i < 6; i++) {
  const inputSelector = `[data-cy="otp-${i}"]`;
  
  await targetPage.waitForSelector(inputSelector, { timeout: 30000 });
  await targetPage.focus(inputSelector);
  await targetPage.type(inputSelector, otpDigits[i], { delay: 150 });
}
```

### **6. Submit OTP (Lines ~1115-1130)**
```typescript
await targetPage.waitForSelector('[data-cy="submit-otp-button"]', {
  visible: true,
  timeout: 30000
});

await targetPage.waitForFunction(() => {
  const button = document.querySelector('[data-cy="submit-otp-button"]');
  return button && !button.disabled;
});

await targetPage.click('[data-cy="submit-otp-button"]');
await delay(3000);
```

---

## 🎯 Summary

The **complete flow** works by:

1. ✅ **Detecting the iframe** after clicking payout tab
2. ✅ **Entering iframe context** by using `targetPage = frame`
3. ✅ **Clicking "via Email" INSIDE iframe** using multiple methods
4. ✅ **Waiting for OTP form** to appear inside iframe
5. ✅ **Fetching OTP from Gmail** using Gmail API
6. ✅ **Filling OTP inputs INSIDE iframe** one by one
7. ✅ **Submitting OTP INSIDE iframe**
8. ✅ **Scraping card data** after iframe closes
9. ✅ **Saving to database**

The **critical fix** was using `targetPage = frame` so that ALL operations (clicks, waits, evaluations) happen **inside the iframe** instead of on the main page!

---

**Key Files:**
- `src/agoda/retriveal-data/retriveal-data.ts` - Main logic
- `src/agoda/utils/retriveal-email.ts` - Gmail OTP fetching
- `src/agoda/utils/selectors.ts` - Element selectors

**Key Functions:**
- `searchBookingAndNavigateToPayout()` - Iframe detection
- `handleOtpVerification()` - Email button click and OTP submission
- `getYcsRetrievalOtpCode()` - Gmail OTP retrieval
- `scrapeUpcWidgetData()` - Card data extraction
