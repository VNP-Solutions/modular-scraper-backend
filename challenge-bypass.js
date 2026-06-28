/**
 * Booking.com challenge.js BYPASS
 * 
 * Injects before other scripts to set human flags
 * 
 * Usage: Include this script BEFORE booking.com loads
 */
(function() {
    // 1. Set hasJS class (required)
    document.documentElement.className = 
        document.documentElement.className.replace('noJS', '') + ' hasJS';
    
    // 2. Initialize booking object if needed
    window.booking = window.booking || {};
    window.booking.env = window.booking.env || {};
    
    // 3. Set robot detection flags to HUMAN
    window.booking.env.b_agent_is_no_robot = true;
    window.booking.env.b_agent_is_robot = false;
    
    // 4. Set believable user agent string
    window.booking.env.b_gtt = window.booking.env.b_gtt || 'dLYAeZFVJfNTBBFPbZWJScebVJfcbQSXMGUYdRKe';
    
    // 5. Set action (normal browsing)
    window.booking.env.b_action = window.booking.env.b_action || 'gen404';
    
    // 6. Set site type
    window.booking.env.b_site_type = window.booking.env.b_site_type || 'www';
    window.booking.env.b_site_type_id = window.booking.env.b_site_type_id || '1';
    
    // 7. Set language
    window.booking.env.b_lang = window.booking.env.b_lang || 'en';
    window.booking.env.b_locale = window.booking.env.b_locale || 'en-us';
    window.booking.env.b_lang_for_url = window.booking.env.b_lang_for_url || 'en-us';
    
    // 8. Set country
    window.booking.env.b_guest_country = window.booking.env.b_guest_country || 'us';
    
    // 9. Initialize empty user object
    window.booking.user = window.booking.user || {};
    
    // 10. Initialize experiments
    window.booking._onfly = window.booking._onfly || [];
    window.booking.devTools = window.booking.devTools || { trackedExperiments: [] };
    
    // 11. Display settings
    window.booking.env.isRetina = window.devicePixelRatio > 1;
    
    console.log('[BYPASS] challenge.js initialized - Human flags set');
})();