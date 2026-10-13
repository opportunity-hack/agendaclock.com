// Load environment variables
require('dotenv').config();

const bodyParser = require('body-parser');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const route_index = require('./routes/index');
const route_meeting = require('./routes/meeting');
const route_auth = require('./routes/auth');
const { passport } = require('./config/auth');

const app = express();

// Compression middleware
app.use(compression());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true in production with HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Make user available in templates
app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

// Routes
app.use('/auth', route_auth);
app.use('/meeting', route_meeting);
// SEO canonicalization: content pages live at slash-less URLs. Trailing-slash
// duplicates returned 200 (splitting ranking signals in Search Console), and
// the retired timed-agenda slug 404'd. 301 both to the canonical URL.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const suffix = req.url.slice(req.path.length);
  if (req.path === '/timed-agenda-templates-time-boxing-guide') {
    return res.redirect(301, '/timed-agenda' + suffix);
  }
  if (
    req.path.length > 1 &&
    req.path.endsWith('/') &&
    !req.path.startsWith('/meeting/') &&
    !req.path.startsWith('/auth/') &&
    !req.path.startsWith('/socket.io') &&
    !req.path.includes('.')
  ) {
    return res.redirect(301, req.path.slice(0, -1) + suffix);
  }
  next();
});

app.use('/', route_index);


module.exports = app;
