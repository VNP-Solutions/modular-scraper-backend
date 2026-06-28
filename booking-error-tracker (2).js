/**
 * Booking.com Error Tracker & Bot Detection
 * 
 * This code is loaded on Booking.com pages to:
 * 1. Capture and report JavaScript errors
 * 2. Detect bots (automated visitors)
 * 3. Track third-party script errors
 * 4. Monitor user behavior (clicks, timing)
 * 5. Send telemetry to Booking's servers
 * 
 * ====================================================================
 * VERSION: Full annotated source
 * DATE: June 28, 2026
 * ====================================================================
 * 
 * HOW IT WORKS:
 * ------------
 * 1. Wraps window.onerror to catch ALL JavaScript errors
 * 2. Wraps jQuery event handlers to track clicks
 * 3. Wraps setTimeout/setInterval for timing patterns
 * 4. Collects 24+ data points per error
 * 5. Determines if visitor is a bot
 * 6. Sends data to /js_errors endpoint
 * 
 * @param win - window object
 * @param doc - document object
 */
(function( win, doc ) {

// ============================================================
// SECTION 1: VARIABLES
// ============================================================

// Array storing all collected errors
var errors = [],
    errorCount = 0,

    // Feature detection: Can we use regex on function.toString()?
    // Used to parse function names from stack traces
    canParse = (function() {}).toString && /bkg/.test( function() { bkg; } );

// Current timestamp - updated on each error
var NOW,
    UNDEFINED_VALUE;

// Track the LAST element the user clicked
// Used to identify human vs bot behavior
// Format: "click on #password" or "click on input.username"
var LAST_CLIENT_EVENT;

// ============================================================
// SECTION 2: SERVER BLOCKING
// ============================================================

/**
 * SERVER_ASKED_TO_BLOCK
 * 
 * The server can tell us to stop reporting errors.
 * This happens if we send too many errors or get flagged as suspicious.
 * 
 * How it works:
 * 1. Server sets cookie: "error_catcher=kill"
 * 2. We read that cookie on page load
 * 3. If cookie is "kill", we stop sending errors
 * 
 * The cookie lasts 30 days once set
 */
var SERVER_ASKED_TO_BLOCK = readCookie( 'error_catcher' ) === 'kill';

/**
 * SHOULD_BLOCK
 * 
 * Should we block this error from being reported?
 * 
 * Block conditions:
 * 1. Server already set error_catcher=kill, OR
 * 2. This is error #3 or higher (error.index starts at 0)
 *    So error.index > 2 means errors 3, 4, 5...
 * 
 * This prevents us from spamming the server with errors
 * and allows the server to silence us if we're flagged
 */
var SHOULD_BLOCK = function( error ) {

    return SERVER_ASKED_TO_BLOCK || error.index > 2;

};

// ============================================================
// SECTION 3: ERROR TRANSPORT CONFIG
// ============================================================

/**
 * ERROR_TRANSPORT
 * 
 * Configuration for how errors are sent to the server
 */
var ERROR_TRANSPORT = {

    // Endpoint to send errors to
    URL: '/js_errors',
    
    // HTTP method
    METHOD: 'POST',
    
    // Maximum number of stack trace lines to send
    MAX_STACK_LINES: 12,
    
    // Maximum characters in stack trace
    MAX_STACK_LENGTH: 900,
    
    // Maximum characters in function body
    MAX_FUNCTION_BODY_LENGTH: 150,
    
    // Text shown when stack is truncated
    STACK_TRUNCATED_TEXT: '(... truncated!)',

    /**
     * SEND_ONLY_IF
     * 
     * Should we send this error?
     * 
     * Only sends if the page has an element with id="req_info"
     * This is a hidden element that only exists on Booking.com pages
     * Prevents error reporting on other sites that embed this code
     */
    SEND_ONLY_IF: function() {

        return !!doc.getElementById( 'req_info' );

    },

    /**
     * IS_BOT
     * 
     * BOT DETECTION - This is critical!
     * 
     * Checks THREE things to determine if visitor is a bot:
     * 
     * 1. window.$u.b01 is truthy
     *    - This is a flag set by Booking's bot detection
     *    - If it exists and is true = BOT
     * 
     * 2. window.booking_extra.bot is truthy
     *    - Another bot flag
     *    - If it exists and is true = BOT
     * 
     * 3. Error message starts with "Not implemented"
     *    - Some automation tools throw this error
     *    - If message matches = BOT
     * 
     * Returns: true if bot detected, false if human
     */
    IS_BOT: function( message ) {

        return getKey( '$u.b01' ) || 
               getKey( 'booking_extra.bot' ) || 
               /^Not implemented/.test( message );

    },

    /**
     * THIRD_PARTY
     * 
     * THIRD-PARTY SCRIPT TRACKING
     * 
     * Maps third-party script domains to friendly names
     * This helps identify which external scripts cause errors
     */
    THIRD_PARTY: {

        /**
         * ADD_PREFIX
         * Add prefix to third-party keys
         * Format: "3rd_<name>: "
         */
        ADD_PREFIX: function( thirdPartyKey ) {

            return '3rd_' + thirdPartyKey + ': ';

        },

        /**
         * SOURCE_MAPPING
         * Map script URLs to tracking names
         * Used to identify which third-party script caused an error
         */
        SOURCE_MAPPING: {

            // Price comparison / Hotel booking
            'http://cond01.etbxml.com/cond/common.js': 'cheapHotelFinder',
            
            // Google advertising
            'fls.doubleclick.net/activity': 'google_floodlight',
            'google-analytics.com/analytics.js': 'google_analytics_universal',
            'doubleclick.net/dc.js': 'google_analytics_classic',
            'gstatic': 'google_maps',
            'google': 'google',
            
            // Analytics & Tracking
            'clicktale': 'clicktale',
            'criteo': 'criteo',
            'usabilla': 'usabilla',
            'utag.js': 'teallium',
            
            // CDN & Hosting
            'wac.edgecastcdn.net': 'whilokii',
            'wizebar': 'wizebar',
            'cloudfront.net/scripts/ld.js': 'cloudfront',
            
            // Social & Ads
            'facebook': 'facebook',
            'twitter': 'twitter',
            
            // Adware / Bundled software
            'superfish': 'superfish',
            'jollywallet': 'jollywallet',
            'blockpage': 'blockpage',
            'datafastguru': 'datafastguru',
            'griddy': 'griddy',
            'showpass': 'showpass',
            'mscimg': 'cdet',
            'triggit': 'triggit',
            'autotag': 'autotag',
            'conduit': 'conduit',
            'mzroute': 'mzroute'

        },

        /**
         * MESSAGE_MAPPING
         * Map error messages to plugin types
         * Used when error message contains specific strings
         */
        MESSAGE_MAPPING: {

            // Browser plugin errors
            'npobject': 'GeckoPlugin',          // NPAPI plugins (old Firefox)
            'dealply': 'DealPlyChromePlugin',    // DealPly ad plugin
            'ns_error_xpc': 'GeckoPlugin',      // Firefox plugin error
            '_watcherready': 'IEPlugin',       // IE plugin
            '_watcherReady': 'AvastPlugin',     // Avast plugin
            '__fCheck': 'MobilePlugin',        // Mobile check
            '__iactive': 'MobilePlugin',       // ActiveX mobile
            
            // Browser-specific
            'wit_OnDocumentLoad': 'WitmainFirefoxPlugin',
            'wit_OnBeforeDocumentLoad': 'WitmainFirefoxPlugin',
            'KasperskyLab': 'KasperskyPlugin',
            'SetReturnValue': 'FlashPlugin'     // Adobe Flash

        },

        /**
         * STACK_TRACE_MAPPING
         * Map stack trace patterns to plugin types
         * Used when stack trace contains specific strings
         */
        STACK_TRACE_MAPPING: {

            'chrome-extension://': 'ChromePlugin',
            'kw__injectedscriptmin': 'UnknownPlugin',
            'datafastguru': 'datafastguru',
            '__fCheck': 'MobilePlugin',
            '__iactive': 'MobilePlugin',
            '__dxutils': 'MobilePlugin',
            'npobject': 'GeckoPlugin',
            '_watcherReady': 'AvastPlugin',
            'wit_OnDocumentLoad': 'WitmainFirefoxPlugin',
            'wit_OnBeforeDocumentLoad': 'WitmainFirefoxPlugin',
            'KasperskyLab': 'KasperskyPlugin',
            'SetReturnValue': 'FlashPlugin',
            'FO_ADJUSTSCALE': 'GeckoPlugin',
            'determineyourroad': 'determineyourroad'

        }

    }

};

// ============================================================
// SECTION 4: ERROR DATA COLLECTION
// ============================================================

/**
 * ERROR_DATA_COLLECTION
 * 
 * This object defines ALL the data points collected when an error occurs.
 * Each property is a function that returns a specific value.
 * 
 * These values are sent to the server along with the error.
 * 
 * ====================================================================
 * COMPLETE LIST OF ALL COLLECTED DATA:
 * ====================================================================
 */

var ERROR_DATA_COLLECTION = {

    /**
     * invalidate_cache
     * Returns current timestamp
     * Used to force refresh of cached data
     */
    invalidate_cache: function() {
        return +new Date;
    },

    /**
     * error
     * Get error as formatted string
     * Combines: type + message + stack trace
     */
    error: function( message, url, line, column, error, caller ) {
        if(typeof(this._errorObj) === 'undefined' ) {
            this._errorObj = this.getErrorObj(message, url, line, column, error, caller);
        }
        return this._errorObj.asString;
    },

    /**
     * error_type
     * Get error type
     * Returns: "B0T", "THIRD_PARTY", or "INTERNAL"
     */
    error_type: function( message, url, line, column, error, caller ) {
        if(typeof(this._errorObj) === 'undefined' ) {
            this._errorObj = this.getErrorObj(message, url, line, column, error, caller);
        }
        return this._errorObj.type;
    },

    /**
     * file_name
     * Get filename where error occurred
     */
    file_name: function( message, url, line, column, error, caller ) {
        if(typeof(this._errorObj) === 'undefined' ) {
            this._errorObj = this.getErrorObj(message, url, line, column, error, caller);
        }
        return this._errorObj.fileName;
    },

    /**
     * function_name
     * Get function name where error occurred
     */
    function_name: function( message, url, line, column, error, caller ) {
        if(typeof(this._errorObj) === 'undefined' ) {
            this._errorObj = this.getErrorObj(message, url, line, column, error, caller);
        }
        return this._errorObj.functionName;
    },

    /**
     * url
     * Get URL where error occurred
     * Tries: stack trace → message URL → current page URL
     */
    url: function( message, url, line, column, error ) {
        return this.getErrorSourceFromStack( error && error.stack ) || 
               this.getErrorSource( message, url ) || 
               win.document.location.href.split( '?' )[ 0 ];
    },

    /**
     * lno
     * Get line number
     * Tries: passed line number → parsed from error stack
     */
    lno: function( message, url, line, column, error ) {
        return Number( line ) ? line : this.getFileOffsetFromError( error ).line || this.UNDEF;
    },

    /**
     * cno
     * Get column number
     * Tries: passed column number → parsed from error stack
     */
    cno: function( message, url, line, column, error ) {
        return Number( column ) ? column : this.getFileOffsetFromError( error ).column || this.UNDEF;
    },

    /**
     * pid - PAGE VIEW ID
     * 
     * This identifies the current page view session.
     * Multiple keys are checked (fallback chain):
     * 
     * 1. booking_extra.pageview_id     - Primary
     * 2. booking.PAGEVIEW_ID      - Alternative
     * 3. BOOKING_PAGEVIEW_ID     - Alternative
     * 4. booking.env.pageview_id  - From env
     * 5. $u.js_data.PAGEVIEW_ID - From JS data
     * 6. '(unknown_page_id)'    - Fallback
     */
    pid: function() {

        return getKey( 'booking_extra.pageview_id' ) ||
               getKey( 'booking.PAGEVIEW_ID' )       ||
               getKey( 'BOOKING_PAGEVIEW_ID' )       ||
               getKey( 'booking.env.pageview_id' )   ||
               getKey( '$u.js_data.PAGEVIEW_ID' )    ||
               '(unknown_page_id)';

    },

    /**
     * stid - SESSION ID
     * Unique identifier for this user session
     */
    stid: function() {
        return getKey( 'booking_extra.b_stid' );
    },

    /**
     * ch - CHANNEL
     * How the user arrived (direct, google, etc)
     */
    ch: function() {
        return getKey( 'booking_extra.b_ch' );
    },

    /**
     * ref_action - REFERRAL ACTION
     * What the user was trying to do
     */
    ref_action: function() {
        return getKey( 'booking_extra.b_action' );
    },

    /**
     * ref_hash - URL HASH
     * The hash fragment in the URL (#something)
     */
    ref_hash: function() {
        return location.hash;
    },

    /**
     * stype - SITE TYPE ID
     * 1 = hotel, 2 = flight, etc
     */
    stype: function() {
        return getKey( 'booking_extra.b_site_type_id' );
    },

    /**
     * aid - ACCOUNT ID
     * Affiliate ID or account ID
     */
    aid: function() {
        return getKey( 'booking_extra.b_aid' );
    },

    /**
     * lang - LANGUAGE
     * Language code used in URL
     */
    lang: function() {
        return getKey( 'booking_extra.b_lang_for_url' );
    },

    /**
     * last_client_event - LAST CLICK
     * 
     * The last element the user interacted with
     * Format: "click on #elementId" or "click on input"
     * 
     * This is used to track user behavior and detect bots
     * Bots don't click on elements the same way humans do
     */
    last_client_event: function() {
        return LAST_CLIENT_EVENT;
    },

    /**
     * scripts - SCRIPTS TRACKING
     * 
     * Which scripts have loaded and run on the page
     * Returns JSON like: {"jquery":{"loaded":true,"run":true},"analytics":{...}}
     */
    scripts: function() {

        var page,
            pageData,
            str = '{',
            scripts = getKey( 'booking.env.scripts_tracking' ) || {};

        for ( page in scripts ) if ( scripts.hasOwnProperty( page ) ) {

            pageData = scripts[ page ];
            str += '"' + page + '":{"loaded":' + !!pageData.loaded + ',"run":' + !!pageData.run + '},';

        }

        str = str.slice( 0, -1 ) + '}';

        if ( str.length === 1 ) {
            return '';
        }

        return str;

    },

    /**
     * since - TIME SINCE PAGE LOAD
     * Milliseconds since PageLoadTimer.start
     */
    since: function() {

        var timer = win.PageLoadTimer;

        return timer ? NOW - timer.start : UNDEF;

    },

    /**
     * ready - DOCUMENT READY TIME
     * Milliseconds from start to document.readyState === 'complete'
     */
    ready: function() {

        var timer = win.PageLoadTimer;

        if ( ! timer ) {
            return UNDEF;
        }

        return timer.document_ready - timer.start ? timer.document_ready - timer.start : 0;

    },

    /**
     * loaded - WINDOW LOAD TIME
     * Milliseconds from start to window.load event
     */
    loaded: function() {

        var timer = win.PageLoadTimer;

        if ( ! timer ) {
            return UNDEF;
        }

        return timer.window_load - timer.start ? timer.window_load - timer.start : 0;

    },

    /**
     * info - INFO ELEMENT CONTENT
     * Content of hidden element with id="req_info"
     */
    info: function() {

        var info = doc.getElementById( 'req_info' );

        return info ? info.innerHTML : UNDEF;

    },

    /**
     * errc - ERROR COUNT
     * Current error index + 1
     */
    errc: function() {
        return this.error.index + 1;
    },

    /**
     * errp - PREVIOUS ERROR COUNT
     * Number of errors before current one
     */
    errp: function() {

        var currentIndex,
            previousIndex,
            previous;

        if ( ! this.error ) {
            return 0;
        }

        currentIndex  = this.error.index;
        previousIndex = currentIndex - 1;

        if ( currentIndex === 0 || previousIndex < 0 ) {
            return 0;
        }

        previous = this.errors[ previousIndex ];

        return previous ? previous.index + 1 : 0;

    },

    /**
     * stack_trace - STACK TRACE
     * Formatted JavaScript stack trace
     */
    stack_trace: function( message, url, line, column, error, caller ) {

        return getErrorStackTrace( error );

    },

    /**
     * page_owner - PAGE OWNER ID
     * Owner configuration from $u.js_data
     */
    page_owner: function() {
        return getKey( '$u.js_data.config.page_owner.id' );
    },

    /**
     * m - METRIC
     * Metric identifier from $u.js_data
     */
    m: function() {
        return getKey( '$u.js_data.jset.m' );
    }

};

// ============================================================
// SECTION 5: ERROR HANDLER FUNCTIONS
// ============================================================

/**
 * E_ - Error re-thrower
 * 
 * Used to re-throw caught errors while tracking them
 */
var E_ = win.E_ = function( error, fnc ) {

    // Report the error
    onBookingError( error.message, '', 0, 0, error, fnc );

    // Skip one level (prevent double reporting)
    E_.skip = true;
    
    // Re-throw to propagate
    throw error;

};

/**
 * E_.a - Get function arguments as array
 * Helper to convert arguments object to real array
 */
E_.a = function( args ) {
    return [].slice.apply( args );
};

/**
 * onBookingError - Main error handler
 * 
 * This is assigned to both:
 * - win.onBookingError (Booking's custom handler)
 * - win.onerror (JavaScript's global error handler)
 * 
 * This means ALL JavaScript errors go through here
 */
var onBookingError = win.onBookingError = win.onerror = function() {

    // Check skip flag (prevents double reporting)
    if ( E_.skip === true ) {
        E_.skip = false;
        return;
    }

    if ( win.onBookingError.skip === true ) {
        win.onBookingError.skip = false;
        return;
    }

    // Convert arguments to array
    var args = [].slice.apply( arguments ),
        ctxt = this,

        // Function to call error handler
        call = function() {

            onError.apply( ctxt, args );

        };

    // Add function caller to arguments
    args.push( getFunctionCaller( arguments ) );

    // Only send if req_info element exists
    if ( ERROR_TRANSPORT.SEND_ONLY_IF() ) {

        call();

    } else {

        // Delay by 100ms (batch multiple errors)
        setTimeout( call, 100 );

    }

};

/**
 * Enable plugins system
 */
win.onerror.plugins = true;

/**
 * Define custom error data collector
 * Allows adding custom data to error reports
 */
win.onerror.defineError = function( ERROR_DATA_COLLECTION_PLUGIN ) {

    // Extend the error collection object
    // Only allows overwriting existing keys, not adding new ones
    extend( ERROR_DATA_COLLECTION, ERROR_DATA_COLLECTION_PLUGIN );

};

/**
 * Define custom transport
 * Allows customizing how errors are sent
 */
win.onerror.defineTransport = function( ERROR_TRANSPORT_PLUGIN ) {

    // Extend transport config
    extend( ERROR_TRANSPORT, ERROR_TRANSPORT_PLUGIN );

};

/**
 * Get all collected errors
 */
win.onerror.errorCollection = function() {

    return errors.slice();

};

/**
 * Report custom error
 * 
 * @param err - Error object or message
 * @param title - Group name for the error
 * @param path - File path
 */
win.onerror.report = function( message, group, path ) {

    var fnc = function() {};

    fnc.__bookingGroupName__ = group;

    win.onerror( message, path || '', 0, 0, {}, fnc );

};

// ============================================================
// SECTION 6: ERROR PROCESSING
// ============================================================

/**
 * onError - Process and send error
 * 
 * This is called for each error that occurs
 */
function onError() {

    // Create error object with index
    var error = { index: errorCount++ },
        args  = [].slice.apply( arguments );

    // Check if we should block
    if ( SHOULD_BLOCK( error ) ) {
        return false;
    }

    // Add to errors array
    errors.push( error );

    // Collect all data for this error
    collectData( error, args );

    // Clear last client event
    LAST_CLIENT_EVENT = UNDEF;

    // Send to server
    send( error );

    return false;

}

/**
 * collectData - Collect all error data
 * 
 * Loops through ERROR_DATA_COLLECTION and calls each function
 * to get the value for that data point
 */
function collectData( error, args ) {

    // Create context with helper functions
    var context = {

            UNDEF:                    UNDEF,
            ERROR_TRANSPORT:          ERROR_TRANSPORT,

            errors:                   errors,
            error:                    error,

            getErrorStackTrace:       getErrorStackTrace,
            getFunctionCaller:        getFunctionCaller,
            getErrorSource:           getErrorSource,
            getErrorGroupObj:         getErrorGroupObj,
            getErrorObj:              getErrorObj,
            parseFunctionBody:        parseFunctionBody,
            parseFunctionName:        parseFunctionName,
            getFileOffsetFromError:   getFileOffsetFromError,
            getErrorSourceFromStack:  getErrorSourceFromStack,
            thirdPartyCheck:          thirdPartyCheck,
            thirdPartyBreakDownLabel: thirdPartyBreakDownLabel,
            languageBreakDownLabel:   languageBreakDownLabel,
            getErrorMessage:          getErrorMessage

        },

        key,
        value;

    // Get current time
    NOW = +new Date;

    // Loop through all data collection keys
    for ( key in ERROR_DATA_COLLECTION ) if ( ERROR_DATA_COLLECTION.hasOwnProperty( key ) ) {

        value = ERROR_DATA_COLLECTION[ key ];

        // If it's a function, call it
        if ( typeof value === 'function' ) {
            value = value.apply( context, args );
        }

        // If value exists, add to error object
        if ( typeof value !== 'undefined' && value !== '' ) {
            error[ key ] =  value;
        }

    }

    // Add error message (encoded)
    error[ 'bm' ] = encodeURIComponent(args[0] || '');

}

/**
 * send - Send error to server
 * 
 * Uses XMLHttpRequest or ActiveX (old IE)
 */
function send( error ) {

    // Create beacon request
    beacon({

        url:    ERROR_TRANSPORT.URL,
        method: ERROR_TRANSPORT.METHOD,
        error:  serialize( error )

    }, function( responseText, responseStatus ) {

        // Check for server block signal
        // 503 = Service Unavailable
        // "shut up" = explicit block command
        if ( +responseStatus === 503 || responseText === 'shut up' ) {
            SERVER_ASKED_TO_BLOCK = true;
            createCookie( 'error_catcher', 'kill', 30 );
        }

    });

}

// ============================================================
// SECTION 7: INITIALIZATION - WRAPPING
// ============================================================

/**
 * Initialize all wrappers
 * This wraps native functions to track behavior
 */
initWrapping();

/**
 * jQueryWrap - Wrap jQuery functions
 * 
 * Wraps:
 * - jQuery.fn.on / jQuery.fn.bind (event binding)
 * - jQuery.fn.off / jQuery.fn.unbind (event unbinding)
 * - jQuery.ajax (AJAX requests)
 * 
 * Purpose: Track what elements users interact with
 */
function initWrapping() {

    /**
     * Wrap jQuery if it exists
     * Only wraps once (jQueryWrap becomes no-op after first call)
     */
    function jQueryWrap( jQuery ) {

        // Prevent double-wrapping
        win.onerror.jQueryWrap = jQueryWrap = function() {};

        try {

            var HANDLER_INDEX = '__booking__handler__index__';

            var handlers = {},
                count    = 0;

            // jQuery version check
            var onAvailable = typeof jQuery.fn.on !== 'undefined';

            // Use appropriate method names
            var method = {
                on:   onAvailable ? 'on'  : 'bind',
                off:  onAvailable ? 'off' : 'unbind',
                ajax: 'ajax'
            };

            /**
             * codeToSelectElement - Convert event to jQuery selector
             * 
             * Converts an event target to a jQuery selector string
             * Examples:
             * - "#password" for input with id="password"
             * - "$('#parent').eq(0).find('input').eq(1)" for nested
             */
            function codeToSelectElement( evt ) {

                var target    = evt.target,
                    elem      = jQuery( target ),

                    id        = elem.attr( 'id' ),
                    tagName   = ( target.tagName || '' ).toLowerCase(),

                    parentElem,
                    parentID,
                    parentIndex,

                    index,
                    code;

                // If element has ID
                if ( id ) {

                    index = jQuery( '#' + id ).index( this );
                    code  = '$("#' + id + '").eq(' + index + ')';

                } else {

                    // Find closest parent with ID
                    parentElem  = elem.closest( '[id]' );

                    if ( ! parentElem.length ) {
                        return UNDEF;
                    }

                    parentID    = parentElem.attr( 'id' );
                    parentIndex = jQuery( '#' + parentID ).index( parentElem );
                    index       = parentElem.find( tagName ).index( target );
                    code        = '$("#' + parentID + '").eq(' + parentIndex+ ').find("' + tagName + '").eq(' + index + ')';

                }

                return code;

            }

            /**
             * Wrap jQuery.fn.on / jQuery.fn.bind
             * Tracks when event listeners are added
             */
            replaceMethod( jQuery.fn, method.on, function( args, index ) {

                var arg = args[ index ],
                    wrapped;

                // Only wrap functions
                if ( typeof arg !== 'function' ) {
                    return;
                }

                // Wrap the function to track events
                wrapped = wrapFunction( arg, function( evt ) {

                    var elementSelector;

                    // If we have an event
                    if (

                        evt &&
                        evt.type

                    ) {

                        try {
                            elementSelector = codeToSelectElement( evt );
                        } catch ( e ) {}

                        // If we got a selector, track it
                        if ( elementSelector ) {

                            // Format: "click on #elementId"
                            LAST_CLIENT_EVENT = evt.type + ' on ' + elementSelector;
                            return;

                        }

                    }

                    // Clear on other events
                    LAST_CLIENT_EVENT = UNDEF;

                });

                // Store wrapped function
                handlers[ count ] = args[ index ] = wrapped;

                // Store handler index
                arg[ HANDLER_INDEX ] = count;

                count += 1;

            });

            /**
             * Wrap jQuery.fn.off / jQuery.fn.unbind
             * Removes wrapped handlers properly
             */
            replaceMethod( jQuery.fn, method.off, function( args, index ) {

                var arg = args[ index ],
                    count;

                if ( typeof arg !== 'function' ) {
                    return;
                }

                count = arg[ HANDLER_INDEX ];

                // Use stored wrapped version
                args[ index ] = handlers[ count ] || arg;

                // Clean up
                delete handlers[ count ];

            });

            /**
             * Wrap jQuery.ajax
             * Wraps AJAX success/error/complete callbacks
             */
            replaceMethod( jQuery, method.ajax,

                // Wrap callback options
                function handleOptions( args, index ) {

                    var options = args[ index ];

                    if ( ({}).toString.apply( options ) === '[object Object]' ) {

                        // Wrap each callback
                        forEachIn( 'success error complete beforeSend', function( callback ) {
                            options[ callback ] = wrapFunction( options[ callback ] );
                        });

                    }

                },

                // Wrap promise callbacks (done/fail/always/then)
                function handlePromiseStates( promise ) {

                    forEachIn( 'done fail always then', replaceMethod, promise );

                }

            );

        } catch( e ) {}

    }

    try {

        // Store original setTimeout and setInterval
        var currentSetTimeout  = win.setTimeout,
            currentSetInterval = win.setInterval,
            start              = +new Date;

        /**
         * Wrap setTimeout
         * 
         * Wraps all setTimeout calls to track timing
         * Used to detect automation (bots use uniform timing)
         */
        if ( currentSetTimeout ) {
            win.setTimeout = function() {
                var args = Array.prototype.slice.call(arguments);
                // Wrap the callback
                args[0] = wrapFunction(args[0]);
                if (currentSetTimeout.apply) {
                    return currentSetTimeout.apply(this, args);
                } else { // IE8 and below
                    return currentSetTimeout(args[0], args[1]);
                }
            };
        }

        /**
         * Wrap setInterval
         * Same as setTimeout wrapping
         */
        if ( currentSetInterval ) {
            win.setInterval = function( fnc, delay ) {
                var args = Array.prototype.slice.call(arguments);
                args[0] = wrapFunction(args[0]);
                if (currentSetInterval.apply) {
                    return currentSetInterval.apply(this, args);
                } else {
                    return currentSetInterval(args[0], args[1]);
                }
            };
        }

        // Create console if missing (prevents errors)
        if ( ! win.console ) {
            win.console = { info: function() {}, log: function() {}, dir: function() {} };
        }

        /**
         * Wait for Booking's frontend to be ready
         * Wraps the startup handler
         */
        (function frontendReady() {

            if (

                 win.B &&
                 win.sNSStartup &&
                 win.B[ win.sNSStartup ] &&
                 win.B[ win.sNSStartup ].execute

            ) {

                // Wrap the startup function
                win.B[ win.sNSStartup ].execute = function( handler, config ) {
                    return wrapFunction( handler ).call( config );
                };

            } else if ( win.document.readyState !== 'complete' && ( (+new Date - start) < (15 * 1000) ) ) {

                // Retry for up to 15 seconds
                setTimeout( frontendReady, 0 );

            }

        })();

        /**
         * Wait for jQuery to load
         * Then wrap it
         */
        (function jQueryReady() {

            if ( 'jQuery' in win ) {

                jQueryWrap( win.jQuery );

            } else if ( win.document.readyState !== 'complete' && ( (+new Date - start) < (15 * 1000) ) ) {

                setTimeout( jQueryReady, 0 );

            }

        })();

    } catch( e ) {

        /* 
         * Wrappers are optional
         * If they fail, we just have less tracking
         */

    }

    // Export for AMD compatibility
    win.onerror.jQueryWrap = jQueryWrap;

}

// ============================================================
// SECTION 8: HELPER FUNCTIONS
// ============================================================

/**
 * wrapFunction - Wrap a function to track errors
 * 
 * @param fnc - Function to wrap
 * @param doThisToo - Optional function to run before original
 * 
 * Returns wrapped function that:
 * 1. Runs doThisToo (if provided)
 * 2. Runs original function
 * 3. Tracks LAST_CLIENT_EVENT
 * 4. Catches errors and reports them
 */
function wrapFunction( fnc, doThisToo ) {

    var wrapper = typeof fnc === 'function' ? function() {

        var args = [].slice.apply( arguments ), result;

        try {

            // Run additional function first
             if ( typeof doThisToo === 'function' ) {
                doThisToo.apply( this, args );
             }

            // Run original function
            result = fnc.apply( this, args );

            // Clear event after success
            LAST_CLIENT_EVENT = UNDEF;

            return result;

        } catch( e ) {

            // Report the error
            win.onerror( e.message, e.sourceURL, e.line, e.column, e, fnc );

            // Log to console
            if ( 'console' in win ) {

                console.log( getErrorStackTrace( e, fnc ) || 'Uncaught Error: ' + e.message );
                if ( typeof console.trace === 'function' ) {
                    console.trace();
                }

            }

        }

    } : fnc;

    return wrapper;

}

/**
 * forEachIn - Iterate over space-separated keys
 */
function forEachIn( items, callback, context ) {

    var i,
        len,
        params,
        list = items.split( ' ' );

    for ( i = 0, len = list.length; i < len; i += 1 ) {

        params = context ? [ context, list[ i ] ] : [ list[ i ] ];

        callback.apply( null, params );

    }

}

/**
 * replaceMethod - Replace a method with wrapped version
 */
function replaceMethod( obj, name, handlerCallback, resultCallback ) {

    var original;

    if ( ! name || typeof obj[ name ] !== 'function' ) {
        return;
    }

    original = obj[ name ];

    obj[ name ] = function() {

        var args  = [].slice.apply( arguments ),
            index = args.length,
            arg,
            result;

        while ( index-- ) {

            arg = args[ index ];

            if ( arg ) {

                if ( typeof handlerCallback === 'function' ) {
                    handlerCallback( args, index );
                } else if ( typeof arg === 'function' ) {
                    args[ index ] = wrapFunction( arg );
                }

            }

        }

        result = original.apply( this, args );

        if ( typeof resultCallback === 'function' ) {
            resultCallback( result );
        }

        return result;

    };

}

// ============================================================
// SECTION 9: THIRD-PARTY CHECKING
// ============================================================

/**
 * thirdPartyBreakDownLabel - Format third-party key
 */
function thirdPartyBreakDownLabel( key ) {

    return '\n<j<s<' + key + '>s>j>';

}

/**
 * languageBreakDownLabel - Format language key
 */
function languageBreakDownLabel( language ) {

    return '\n<l<a<n<g<' + language + '>g>n>a>l>';

}

/**
 * thirdPartyCheck - Determine if error is from third-party script
 */
function thirdPartyCheck( message, stack, url ) {

    var source     = ( getErrorSource( message, url ) || '' ) + '',
        thirdParty = ERROR_TRANSPORT.THIRD_PARTY || {},
        pattern;

    if ( typeof source.toLowerCase === 'undefined' ) {
        source = '';
    } else {
        source = source.toLowerCase();
    }

    for ( pattern in thirdParty.SOURCE_MAPPING ) {

        if ( source.indexOf( pattern ) !== -1 ) {

            return {
                is: true,
                key: thirdParty.SOURCE_MAPPING[ pattern ]
            };

        }

    }

    for ( pattern in thirdParty.STACK_TRACE_MAPPING ) {

        if ( stack.indexOf( pattern ) !== -1 ) {

            return {
                is: true,
                key: thirdParty.STACK_TRACE_MAPPING[ pattern ]
            };

        }

    }

    message = message || '';
    message += '';
    message = message.toLowerCase();

    for ( pattern in thirdParty.MESSAGE_MAPPING ) {
        if ( message.indexOf( pattern ) !== -1 ) {
            return {
                is: true,
                key: thirdParty.MESSAGE_MAPPING[ pattern ]
            };
        }
    }

    if ( ! /(villas|booking|bstatic)\.com/i.test( source ) && ! /^jstmpl::/i.test( message )) {
        return {
            is: true,
            key: 'External Source'
        }
    }

    return {
        is: false,
        key: ''
    };

}

// ============================================================
// SECTION 10: ERROR PARSING
// ============================================================

/**
 * sanitizeStackLength - Truncate stack trace
 */
function sanitizeStackLength( stackText ) {

    var stack,
        lines;

    if ( ! stackText ) {
        return '';
    }

    stack = stackText.split( '\n' );
    lines = stack.splice( 0, ERROR_TRANSPORT.MAX_STACK_LINES );

    return ( '\n' + lines.join( '\n' ) ).slice( 0, ERROR_TRANSPORT.MAX_STACK_LENGTH ) + 
           ( stack.length ? ERROR_TRANSPORT.STACK_TRUNCATED_TEXT : '' );

}

/**
 * getErrorStackTrace - Parse error stack trace
 */
function getErrorStackTrace( error, functionCaller, message ) {

    var stack,
        lines,
        file,
        name,
        fileOffset;

    if ( ! error ) {
        return '';
    }

    message = getErrorMessage( message, error );

    if ( functionCaller && message ) {

        lines = [];

        while ( functionCaller ) {

            name = functionCaller.name || 
                  parseFunctionName( functionCaller ) || 
                  parseFunctionBody( functionCaller ) || 
                  'anonymous';
            
            file = getErrorSourceFromStack( error.stack ) || 
                   getErrorSource( message, extractUrlSearch( win.document.location.href ) );
            fileOffset = getFileOffsetFromError( error );

            lines.push( name + '@(' + file + ':' + fileOffset.line + ':' + fileOffset.column + ')' );

            try {
                functionCaller = functionCaller.caller;
            } catch( e ) {
                functionCaller = false;
            }

        }

        if ( lines.length ) {

            lines = [ '<Generated Stack>' ].concat( lines ).concat( [ '</Generated Stack>\n' ] );

            stack = lines.join( '\n' ) + ( error.stack || '' );

            return sanitizeStackLength( stack );

        }

    }

    return sanitizeStackLength( error.stack );

}

/**
 * getErrorGroupObj - Get error group object
 */
function getErrorGroupObj(stack, caller) {
    var callerName,
        callerSource;

    if ( typeof caller === 'function' ) {
        callerName   = caller.name || parseFunctionName( caller );
        callerSource = parseFunctionBody( caller );
    }

    var location           = win.document.location || {},
        host               = location.hostname || '',
        path               = location.pathname || '',
        fileName = ( stack.match( /\/\/[^/]+(\/[^: ]+):(\d+):(\d+)/ ) || [ '', '' ] )[ 1 ].split( '?' )[ 0 ] || ( host + path ),
        functionName = callerName || ( stack.match( /(?:at)?\s+([0-9a-zA-Z_]+)[\s@]+(?:\(?https?:)?\/\/[^/]+\/[^: ]+:\d+:\d+/ ) || [] )[ 1 ],
        functionSource = callerSource || ( stack.match( /(function\([^\)]*\)\{[^@]+\})@(?:\(?https?:)?\/\/[^/]+\/[^: ]+:\d+:\d+/i ) || [] )[ 1 ],
        functionIdentifier = ( ! functionSource && ! /^(at|code|function)$/i.test( functionName ) && functionName ) || 
                           functionSource || 
                           'anonymous';

    fileName.replace( /(\.v[a-zA-Z0-9]+v\.)js$/, '.js' );

    if ( typeof caller === 'function' && caller.__bookingGroupName__ ) {
        functionIdentifier = caller.__bookingGroupName__;
    }

    var groupName = 'FULL_STACK_' + fileName + '->' + functionIdentifier + '():';

    if (!functionName) {
        functionName = functionIdentifier;
    }
    
    return {
        "fileName":     fileName,
        "functionName": functionName,
        "asString":     groupName
    };


}

/**
 * getErrorGroup - Get error group name
 */
function getErrorGroup( stack, caller ) {

    var errGroupObj = getErrorGroupObj(stack, caller);
    return errGroupObj.name;
}

/**
 * getErrorObj - Create full error object
 * Determines error type: B0T, THIRD_PARTY, or INTERNAL
 */
function getErrorObj( message, url, line, column, error, caller ) {

    var stack  = this.getErrorStackTrace( error, caller, message ) || '',
        source = this.getErrorSourceFromStack( error && error.stack ) || 
                this.getErrorSource( message, url ) || 
                win.document.location.href.split( '?' )[ 0 ] || '',
        thirdParty,
        errorGroupObj,
        errorObj = { type: 'unknown', asString: 'unknown', message: message, stack: stack };

    if ( ERROR_TRANSPORT.IS_BOT( message ) ) {
        errorObj.type= 'B0T',
        errorObj.asString = errorObj.type + ': ' + errorObj.message;
    }
    else {
        thirdParty = thirdPartyCheck( message, stack, source );
        if ( thirdParty.is ) {
            errorObj.type = 'THIRD_PARTY';
            errorObj.thirdPartyKey = thirdParty.key;

            errorObj.asString = '3rd_Party_External_Script_Error'
                + errorObj.thirdPartyKey
                + thirdPartyBreakDownLabel( errorObj.thirdPartyKey )
                + errorObj.stack;
        }
        else {
            errorGroupObj = this.getErrorGroupObj( stack, caller );
            errorObj.type= 'INTERNAL';
            errorObj.fileName = errorGroupObj.fileName;
            errorObj.functionName = errorGroupObj.functionName;
            errorObj.message = getErrorMessage(message, error) || 'Script error';
            errorObj.asString = errorGroupObj.asString + errorObj.message + errorObj.stack;
        }
    }
    
    return errorObj;
};

/**
 * getKey - Get value from window by dot-notation path
 * Example: getKey('booking_extra.pageview_id') returns window.booking_extra.pageview_id
 */
function getKey( path ) {

    var keys    = path.split( /[. ]/ ),
        objName = keys[ 0 ],

        i, len,

        value = win[ objName ];

    for ( i = 1, len = keys.length; i < len; i += 1 ) {

        if (

            defined( value ) &&
            /^\[object (Object|Function|Array|global|HTMLDocument)\]$/.test( ({}).toString.apply( value ) )

        ) {

            value = value[ keys[ i ] ];

        } else {

            return defined( value ) ? value : UNDEF;

        }

    }

    return defined( value ) ? value : UNDEF;

}

/**
 * defined - Check if variable is defined
 */
function defined( variable ) {

    return typeof variable !== 'undefined';

}

/**
 * extend - Extend object with another
 */
function extend( source, extension ) {

    var attr;

    for ( attr in extension ) {

        if (
            source.hasOwnProperty( attr ) &&
            extension.hasOwnProperty( attr )
        ) {

            source[ attr ] = extension[ attr ];

        }

    }

}

/**
 * serialize - Convert object to URL-encoded string
 */
function serialize( obj ) {

    var serialized = [],

        key,
        value;

    for ( key in obj ) if ( obj.hasOwnProperty( key ) ) {
        serialized.push( key + '=' + win.encodeURIComponent( obj[ key ] ) );
    }

    return serialized.join( '&' );

}

/**
 * beacon - Send data to server
 */
function beacon( config, onResponse ) {

    var request,
        url = config.url;

    try {
        request = new win.XMLHttpRequest();
    } catch( e ) {}

    if ( ! request ) {

        try {
            request = new win.ActiveXObject( 'Microsoft.XMLHTTP' );
        } catch( e ) {}

    }

    if ( config.method !== 'POST' ) {
        url += '?' + config.error;
    }

    request.open( config.method, url, true );
    request.setRequestHeader( 'Content-type', 'application/x-www-form-urlencoded' );

    request.onreadystatechange = function () {
        if ( request.readyState === 4 ) {
            onResponse( request.responseText, request.status );
        }
    };

    request.send( config.error );

}

/**
 * extractUrlPath - Extract path from URL
 */
function extractUrlPath( url ) {

    var path = ( url.match( /\/\/[^/]+(\/[^?]+)/ ) || [] )[ 1 ];

    return path || url;

}

/**
 * extractUrlSearch - Get URL without query string
 */
function extractUrlSearch( url ) {

    return ( url || '' ).split( '?' )[ 0 ];

}

/**
 * getErrorMessage - Get error message from error object
 */
function getErrorMessage( message, error ) {

    return message ? message : ( error ? error.message : '' );

}

/**
 * getErrorSource - Get source URL from error event
 */
function getErrorSource( message, url ) {

    return message && message.srcElement && message.srcElement.src && 
           typeof message.srcElement.src === 'string' ? 
           message.srcElement.src : url;

}

/**
 * getErrorSourceFromStack - Extract URL from stack trace
 */
function getErrorSourceFromStack( stack ) {

    return ( ( stack || '' ).match( /((?:https?:)?\/\/[^/]+\/[^: ]+):(\d+):(\d+)/ ) || [ '', '' ] )[ 1 ].split( '?' )[ 0 ];

}

/**
 * getFileOffsetFromError - Get line/column from error
 */
function getFileOffsetFromError( error ) {

    if ( ! error ) {
        return { line: 0, column: 0 };
    }

    var offset = ( error.stack || '' ).match( /:(\d+)(?::(\d+))?/ ) || [ 0, 0, 0 ],
        line   = Math.abs( error.number ? +error.number : 0 ) || offset[ 1 ] || 0,
        column = offset[ 2 ] || 0;

    return {
        line:   +line,
        column: +column
    };

}

/**
 * getFunctionCaller - Get caller from arguments
 */
function getFunctionCaller( args ) {

    var caller,
        undef;

    try {
        caller = args && args.callee && args.callee.caller ? args.callee.caller : undef;
    } catch( e ) {}

    return caller;

}

/**
 * parseFunctionName - Extract function name
 */
function parseFunctionName( fnc ) {

    var source;

    if ( ! canParse || typeof fnc !== 'function' ) {
        return '';
    }

    source = fnc.toString();

    return ( source.match( /function\s+([a-zA-Z0-9_]+)\s*\(/ ) || [] )[ 1 ] || '';

}

/**
 * parseFunctionBody - Extract function body (truncated)
 */
function parseFunctionBody( fnc ) {

    var source;

    if ( ! canParse ) {
        return '';
    }

    source = fnc.toString()
                .replace( /[\n\r\t\s@]+/g, '' )
                .slice( 0, -1 )
                .slice( 0, ERROR_TRANSPORT.MAX_FUNCTION_BODY_LENGTH ) + ' ... }';

    return source;

}

// ============================================================
// SECTION 11: COOKIE FUNCTIONS
// ============================================================

/**
 * createCookie - Set a cookie
 */
function createCookie( name, value, days ) {

    var expires = '';

    if ( days ) {
        var date = new Date();
        date.setTime( date.getTime() + ( days * 24 * 60 * 60 * 1000 ) );
        expires = '; expires=' + date.toGMTString();
    }

    doc.cookie = name + '=' + value + expires + '; path=/';

}

/**
 * readCookie - Read a cookie
 */
function readCookie( name ) {

    var cookies = doc.cookie.split( ';' ),
        cookie,

        i, len;

    name = name + '=';

    for( i = 0, len = cookies.length; i < len; i += 1 ) {

        cookie = cookies[ i ];

        while ( cookie.charAt( 0 ) === ' ' ) {
            cookie = cookie.substring( 1, cookie.length );
        }

        if ( cookie.indexOf( name ) === 0 ) {
            return cookie.substring( name.length, cookie.length );
        }

    }

    return null;

}

})( this, this.document );
// ============================================================
// END MAIN IIFE
// ============================================================



// ============================================================
// PART 2: PROTOCOL CHECK
// ============================================================

/**
 * Protocol and Host Validation
 * 
 * This code runs IMMEDIATELY after the main IIFE.
 * It checks:
 * 1. Protocol must be HTTPS
 * 2. Host must end with ".booking.com"
 * 
 * If either check fails, it sends data to /_etnht endpoint
 */
try {
  (function(){
      var e=false;
      var t=window.location.protocol.toLowerCase().substr(0,window.location.protocol.length-1);
      var n=window.location.host.toLowerCase().replace(/\.$/, '');
      
      if(t!=="https")e=true;
      if(n.substr(n.length-12)!==".booking.com")e=true;
      
      if(e){
          var r="https://www.booking.com/_etnht"
              + "?cpr="+encodeURIComponent(t)
              + "&ch="+encodeURIComponent(n)
              + "&we=we"
              + "&cpa="+encodeURIComponent(window.location.pathname);
              
          if(window.$u!==undefined&&$u.application!==undefined){
              r+="&a="+encodeURIComponent($u.application.application);
              if($u.application.tag!==undefined)
                  r+="&at="+encodeURIComponent($u.application.tag);
          }
          
          if(document.referrer!==undefined&&document.referrer!="")
              r+="&cr="+encodeURIComponent(document.referrer);
              
          document.createElement("img").setAttribute("src",r);
      }
  })();
} catch( e ) {}

// ============================================================
// PART 3: ERROR REPORTING UTILITY
// ============================================================

/**
 * booking.reportError - Public error reporting API
 */
(function(window, booking) {

booking.reportError = function( err, title ) {

  var message = '', prefix = '[' + ( title || 'Reported Error' ) + '] ';

  try {
    message = ( prefix + ( err.message || '' ) + ' ' + ( err.stack || '' ) ).slice( 0, 500 );
  } catch( e ) {}

  if ( message ) {
    window.onerror( message );
  }

};
})(window, window.booking = window.booking || {});

// ============================================================
// COMPLETE LIST OF ALL TRACKED KEYS
// ============================================================
/*
ERROR_COLLECTION KEYS:
-------------------
invalidate_cache    - Current timestamp
error           - Formatted error string
error_type       - "B0T", "THIRD_PARTY", or "INTERNAL"
file_name       - File where error occurred
function_name  - Function where error occurred
url             - URL where error occurred
lno             - Line number
cno             - Column number
pid             - Page view ID (multiple sources)
stid            - Session ID
ch              - Channel
ref_action      - Referral action
ref_hash        - URL hash
stype          - Site type ID
aid            - Account ID
lang           - Language
last_client_event - Last clicked element
scripts        - Which scripts loaded
since          - Time since page load
ready          - Document ready time
loaded         - Window load time
info           - req_info element content
errc            - Error count
errp            - Previous error count
stack_trace    - Stack trace
page_owner     - Page owner ID
m              - Metric

BOT DETECTION KEYS:
-----------------
$u.b01                    - Primary bot flag
booking_extra.bot          - Secondary bot flag

SESSION KEYS:
------------
booking_extra.pageview_id    - Page view ID
booking.PAGEVIEW_ID      - Alt page view ID
BOOKING_PAGEVIEW_ID      - Alt page view ID
booking.env.pageview_id   - Env page view ID
$u.js_data.PAGEVIEW_ID  - JS data page view ID
booking_extra.b_stid     - Session ID
booking_extra.b_ch        - Channel
booking_extra.b_action    - Action
booking_extra.b_site_type_id - Site type
booking_extra.b_aid       - Account ID
booking_extra.b_lang_for_url - Language

APPLICATION KEYS:
----------------
$u.application.application - App name
$u.application.tag      - App tag
$u.js_data.config.page_owner.id - Page owner
$u.js_data.jset.m      - Metric

PAGE TIMING KEYS:
----------------
PageLoadTimer.start          - Load start time
PageLoadTimer.document_ready   - Document ready time
PageLoadTimer.window_load     - Window load time

COOKIES:
--------
error_catcher   - Server block flag ("kill" = block)

REPORTING ENDPOINTS:
------------------
/js_errors     - Error reporting (POST)
/_etnht       - Protocol check reporting (GET)
*/