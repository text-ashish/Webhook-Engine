require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { initDB } = require('./db/database');
const { startWorker } = require('./engine/deliveryWorker');
const { apiLimiter, triggerLimiter, createLimiter } = require('./middleware/rateLimiter');

const endpointsRouter = require('./api/endpoints');
const eventsRouter = require('./api/events');
const deliveriesRouter = require('./api/deliveries');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve dashboard
app.use(express.static(path.join(__dirname, '../dashboard')));

// Apply rate limiting
app.use('/api/', apiLimiter);
app.use('/api/events/trigger', triggerLimiter);

// API Routes
app.use('/api/endpoints', endpointsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/deliveries', deliveriesRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 404 handler for API
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// SPA fallback for dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

async function bootstrap() {
  try {
    await initDB();
    startWorker();
    
    app.listen(PORT, () => {
      console.log(`\n🚀 Webhook Delivery Engine running on http://localhost:${PORT}`);
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
      console.log(`🔗 API: http://localhost:${PORT}/api`);
      console.log(`\nPress Ctrl+C to stop\n`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

bootstrap();

module.exports = app;
