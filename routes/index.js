const express = require('express');
const path = require('path');
const router = express.Router();

// Cache headers for near-static SEO pages. The 12 landing pages + sitemap /
// robots render identically for anonymous and logged-in users (no
// user- or date-dependent content - verified in the views), so a public
// cache is safe. Repeat visits within the hour skip the revalidation round
// trip (TTFB 0.27-0.58s) and download zero bytes for HTML. Homepage is
// excluded: it redirects authenticated users to /meeting/. /meeting/* and
// /auth/* live in separate routers and are untouched.
const CACHEABLE_PATHS = new Set([
    '/effective-meetings',
    '/managing-talkative-participants',
    '/productive-meeting-tips',
    '/meeting-agenda-timer',
    '/meeting-length-effectiveness',
    '/ai-changing-meetings',
    '/meeting-introductions-antipattern',
    '/timed-agenda',
    '/obs-setup',
    '/de',
    '/ja',
    '/sg',
    '/sitemap.xml',
    '/robots.txt',
]);
router.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && CACHEABLE_PATHS.has(req.path)) {
        // Content changes only on deploy (weekly at most); a visitor who
        // loaded a page in the last hour may see the pre-deploy copy for
        // up to 1h after a merge.
        res.set('Cache-Control', 'public, max-age=3600');
    }
    next();
});

router.get('/', (req, res) => {
    // Check if user is authenticated
    if (req.isAuthenticated()) {
        res.redirect("/meeting/");
    } else {
        res.render('login', { error: null });
    }
});

// SEO Landing Pages
router.get('/effective-meetings', (req, res) => {
    res.render('effective-meetings');
});

router.get('/managing-talkative-participants', (req, res) => {
    res.render('managing-talkative-participants');
});

router.get('/productive-meeting-tips', (req, res) => {
    res.render('productive-meeting-tips');
});

router.get('/meeting-agenda-timer', (req, res) => {
    res.render('meeting-agenda-timer');
});

router.get('/meeting-length-effectiveness', (req, res) => {
    res.render('meeting-length-effectiveness');
});

router.get('/ai-changing-meetings', (req, res) => {
    res.render('ai-changing-meetings');
});

router.get('/meeting-introductions-antipattern', (req, res) => {
    res.render('meeting-introductions-antipattern');
});

router.get('/timed-agenda', (req, res) => {
    res.render('timed-agenda');
});

router.get('/obs-setup', (req, res) => {
    res.render('obs_setup');
});

// Localized test landing pages (hreflang cluster with /meeting-agenda-timer)
router.get('/de', (req, res) => {
    res.render('meeting-agenda-timer-de');
});

router.get('/ja', (req, res) => {
    res.render('meeting-agenda-timer-ja');
});

router.get('/sg', (req, res) => {
    res.render('meeting-agenda-timer-sg');
});

// SEO Files
router.get('/sitemap.xml', (req, res) => {
    res.type('application/xml');
    res.sendFile(path.join(__dirname, '../public/sitemap.xml'));
});

router.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, '../public/robots.txt'));
});

module.exports = router;
