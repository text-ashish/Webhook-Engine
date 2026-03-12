const rateLimit = require('express-rate-limit');

// General API rate limit — covers all routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});

// Strict limiter for event triggering only
const triggerLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Event trigger rate limit exceeded (120/min).' }
});

// POST-only limiter for endpoint creation
// Applied manually in the router so GET /endpoints is never affected
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Endpoint creation rate limit exceeded (60/min).' }
});

module.exports = { apiLimiter, triggerLimiter, createLimiter };
