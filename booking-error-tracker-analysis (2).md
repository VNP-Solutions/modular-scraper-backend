# Booking.com Error Tracker - Complete Key Analysis

> Extracted from: error---c57ab48f-82f2-4d80-a329-d6676e10daf6.txt
> Date: June 28, 2026

---

## 1. BOT DETECTION KEYS (CRITICAL)

| Key | Purpose | Fix |
|-----|---------|-----|
| `$u.b01` | Primary bot flag | Set to `false` |
| `booking_extra.bot` | Secondary bot flag | Set to `false` |

```javascript
IS_BOT: function( message ) {
  return getKey( '$u.b01' ) || 
         getKey( 'booking_extra.bot' ) || 
         /^Not implemented/.test( message );
}
```

---

## 2. ERROR COLLECTION KEYS

### Page Identification
| Key | Description |
|-----|-------------|
| `booking_extra.pageview_id` | Page view ID |
| `booking.PAGEVIEW_ID` | Alt page view ID |
| `BOOKING_PAGEVIEW_ID` | Alt page view ID |
| `booking.env.pageview_id` | Env page view ID |
| `$u.js_data.PAGEVIEW_ID` | JS data page view ID |

### Session Tracking
| Key | Description |
|-----|-------------|
| `booking_extra.b_stid` | Session ID |
| `booking_extra.b_ch` | Channel |
| `booking_extra.b_action` | Action |
| `booking_extra.b_site_type_id` | Site type |
| `booking_extra.b_aid` | Account ID |
| `booking_extra.b_lang_for_url` | Language for URL |

### Page Timing
| Key | Description |
|-----|-------------|
| `PageLoadTimer.start` | Page load start |
| `PageLoadTimer.document_ready` | Document ready time |
| `PageLoadTimer.window_load` | Window load time |

### jQuery Event Tracking
| Key | Description |
|-----|-------------|
| `LAST_CLIENT_EVENT` | Last clicked element (e.g., "click on #password") |

### Error Context
| Key | Description |
|-----|-------------|
| `booking.env.scripts_tracking` | Which scripts loaded/ran |
| `$u.js_data.config.page_owner.id` | Page owner ID |
| `$u.js_data.jset.m` | JS set m |

---

## 3. SERVER BLOCKING MECHANISM

### Cookie-Based Blocking
| Cookie | Value | Action |
|--------|-------|--------|
| `error_catcher` | `kill` | Block all error reporting |

### Blocking Logic
```javascript
var SERVER_ASKED_TO_BLOCK = readCookie( 'error_catcher' ) === 'kill';
var SHOULD_BLOCK = function( error ) {
  return SERVER_ASKED_TO_BLOCK || error.index > 2;
};
```
- After 3 errors → server can set cookie to block further reporting

---

## 4. THIRD-PARTY TRACKING SOURCES

### Source Mapping
| Domain | Tracking Name |
|--------|--------------|
| `cond01.etbxml.com/cond/common.js` | cheapHotelFinder |
| `fls.doubleclick.net/activity` | google_floodlight |
| `google-analytics.com/analytics.js` | google_analytics_universal |
| `doubleclick.net/dc.js` | google_analytics_classic |
| `gstatic` | google_maps |
| `google` | google |
| `clicktale` | clicktale |
| `criteo` | criteo |
| `usabilla` | usabilla |
| `utag.js` | teallium |
| `wac.edgecastcdn.net` | whilokii |
| `wizebar` | wizebar |
| `facebook` | facebook |
| `superfish` | superfish |
| `jollywallet` | jollywallet |
| `datafastguru` | datafastguru |
| `griddy` | griddy |
| `showpass` | showpass |
| `triggit` | triggit |
| `conduit` | conduit |
| `mzroute` | mzroute |
| `twitter` | twitter |
| `cloudfront.net/scripts/ld.js` | cloudfront |

### Plugin Detection
| Message | Plugin |
|---------|--------|
| `npobject` | GeckoPlugin |
| `dealply` | DealPlyChromePlugin |
| `ns_error_xpc` | GeckoPlugin |
| `_watcherready` | IEPlugin |
| `__fCheck` | MobilePlugin |
| `__iactive` | MobilePlugin |
| `_watcherReady` | AvastPlugin |
| `wit_OnDocumentLoad` | WitmainFirefoxPlugin |
| `KasperskyLab` | KasperskyPlugin |
| `SetReturnValue` | FlashPlugin |

---

## 5. HTTP TRANSPORT CONFIG

```javascript
ERROR_TRANSPORT = {
  URL: '/js_errors',
  METHOD: 'POST',
  MAX_STACK_LINES: 12,
  MAX_STACK_LENGTH: 900,
  MAX_FUNCTION_BODY_LENGTH: 150,
  STACK_TRUNCATED_TEXT: '(... truncated!)',
  
  SEND_ONLY_IF: function() {
    return !!doc.getElementById( 'req_info' );
  }
};
```

---

## 6. BYPASS CODE

```javascript
// === BOOKING.COM ERROR TRACKER BYPASS ===

// 1. Clear bot flags
window.$u = window.$u || {};
window.$u.b01 = false;

window.booking_extra = window.booking_extra || {};
window.booking_extra.bot = false;

// 2. Clear page IDs (regenerate)
window.booking_extra.pageview_id = Date.now() + Math.random().toString(36).substr(2, 9);
window.booking_extra.b_stid = Date.now();

// 3. Clear error catcher cookie
document.cookie = 'error_catcher=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';

// 4. Spoof LAST_CLIENT_EVENT
var originalAddEventListener = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function(type, listener, options) {
  originalAddEventListener.call(this, type, function(e) {
    if (e.target && e.target.id) {
      window.LAST_CLIENT_EVENT = e.type + ' on #' + e.target.id;
    } else if (e.target && e.target.tagName) {
      window.LAST_CLIENT_EVENT = e.type + ' on ' + e.target.tagName.toLowerCase();
    }
    return listener.call(this, e);
  }, options);
};

// 5. Clear timers
window.PageLoadTimer = {
  start: Date.now() - 2000,
  document_ready: Date.now() - 1000,
  window_load: Date.now()
};
```

---

## 7. SUMMARY TABLE

| Category | Count | Critical |
|----------|-------|----------|
| Bot Flags | 2 | ✅ YES |
| Page IDs | 6 | No |
| Session Keys | 6 | No |
| Page Timers | 3 | No |
| Third-Party Sources | 24 | No |
| Plugin Types | 10 | No |
| **TOTAL** | **51** | **2 critical** |

---

## 9. EXTRA DETECTION AT END (MISSED INITIALLY)

### Protocol & Host Check
```javascript
if(t!=="https")e=true;  // Must use HTTPS
if(n.substr(n.length-12)!==".booking.com")e=true;  // Must be booking.com
```
### Reporting Endpoint
```
/_etnht?cpr=<protocol>&ch=<host>&we=we&cpa=<path>&a=<app>&at=<tag>&cr=<referrer>
```

### Additional Keys Tracked
| Key | Description |
|-----|-------------|
| `$u.application.application` | App name |
| `$u.application.tag` | App tag |
| `document.referrer` | Referring URL |
| `window.location.pathname` | Current path |

---

## 10. COMPLETE BYPASS (UPDATED)

```javascript
// === FULL BOOKING.COM BYPASS ===


// 1. Bot flags
window.$u = window.$u || {};
window.$u.b01 = false;
window.$u.application = { application: 'web', tag: 'default' };

window.booking_extra = window.booking_extra || {};
window.booking_extra.bot = false;
window.booking_extra.pageview_id = Date.now() + Math.random().toString(36).substr(2, 9);
window.booking_extra.b_stid = Date.now();
window.booking_extra.b_ch = 'direct';
window.booking_extra.b_action = 'search';
window.booking_extra.b_aid = '12345';
window.booking_extra.b_lang_for_url = 'en';
window.booking_extra.b_site_type_id = '1';

// 2. Referrer spoof
Object.defineProperty(document, 'referrer', { get: () => 'https://www.booking.com/', configurable: true });

// 3. Protocol check (already using https anyway)
// 4. Error catcher cookie
document.cookie = 'error_catcher=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';

// 5. Page timers
window.PageLoadTimer = {
  start: Date.now() - 2000,
  document_ready: Date.now() - 1000,
  window_load: Date.now()
};
```

---

## 8. QUICK FIX

```javascript
// One-liner to block their bot detection
Object.defineProperty(window, '$u', {value: {b01: false}, writable: false});
Object.defineProperty(window, 'booking_extra', {value: {bot: false}, writable: false});
```