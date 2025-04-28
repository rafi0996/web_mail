/**
 * Enhanced Email Scraper with Puppeteer
 * 
 * This script crawls websites from a provided list of URLs,
 * extracts email addresses, and saves them to a CSV file.
 * 
 * Features:
 * - Concurrent crawling with configurable rate limiting
 * - Deep page crawling (follows internal links)
 * - Advanced email validation and deduplication
 * - Proxy support with rotation capability
 * - User agent rotation
 * - Export to CSV with detailed metadata
 * - Comprehensive logging
 * - Email obfuscation detection
 * - HTTP/HTTPS protocol handling
 * - Robots.txt compliance
 * - Rate limiting per domain
 * - Graceful error handling and recovery
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createObjectCsvWriter } = require('csv-writer');
const robotsParser = require('robots-parser');
const https = require('https');
const http = require('http');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Configuration
const CONFIG = {
  // Maximum number of concurrent browser instances
  maxConcurrency: 5,
  
  // Maximum number of pages to crawl per domain
  maxPagesPerDomain: 50,
  
  // Maximum crawl depth from the starting URL
  maxDepth: 3,
  
  // Crawl delay in milliseconds to avoid overloading servers
  crawlDelay: 1500,
  
  // Timeout for page load in milliseconds
  pageTimeout: 45000,
  
  // Navigation timeout
  navigationTimeout: 60000,
  
  // User agents to rotate
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.55 Safari/537.36',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:95.0) Gecko/20100101 Firefox/95.0'
  ],
  
  // Multiple proxy configuration for rotation
  proxies: [
    { server: 'http://proxy-server1:port', username: 'user1', password: 'pass1' },
    { server: 'http://proxy-server2:port', username: 'user2', password: 'pass2' }
    // Add more proxies as needed
  ],
  
  // Enable proxy rotation
  useProxies: false,
  
  // Respect robots.txt
  respectRobotsTxt: true,
  
  // Output file path
  outputFile: 'extracted_emails.csv',
  
  // Log file path
  logFile: 'scraper_log.txt',
  
  // Detailed debugging
  debug: false,
  
  // Rate limiting per domain (requests per minute)
  requestsPerMinutePerDomain: 20,
  
  // Enable screenshot capture on errors for debugging
  captureScreenshotOnError: true,
  
  // Screenshot directory
  screenshotDir: 'error_screenshots',
  
  // Email validation options
  emailValidation: {
    // Check MX records for domain validity
    checkMxRecords: false,
    
    // Exclude common disposable email domains
    excludeDisposable: true,
    
    // Exclude specific domains
    excludeDomains: ['example.com', 'test.com', 'domain.com']
  }
};

// Store for processed URLs to avoid duplicates
const processedUrls = new Set();

// Store for extracted emails to avoid duplicates
const extractedEmails = new Set();

// Store domains we've visited with timestamps for rate limiting
const visitedDomains = new Map();

// Map to store robots.txt data by domain
const robotsTxtCache = new Map();

// Common disposable email domains
const disposableEmailDomains = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com',
  'mailnesia.com', '10minutemail.com', 'trashmail.com', 'yopmail.com',
  'dispostable.com', 'sharklasers.com', 'throwawaymail.com', 'fakeinbox.com'
]);

// Helper to get next proxy in rotation
let proxyIndex = 0;
const getNextProxy = () => {
  if (!CONFIG.useProxies || CONFIG.proxies.length === 0) return null;
  const proxy = CONFIG.proxies[proxyIndex];
  proxyIndex = (proxyIndex + 1) % CONFIG.proxies.length;
  return proxy;
};

// Helper to get a random user agent
const getRandomUserAgent = () => {
  return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
};

// Helper to extract domain from URL
const getDomainFromUrl = (urlString) => {
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch (error) {
    logToFile(`Error parsing URL ${urlString}: ${error.message}`, 'ERROR');
    return null;
  }
};

// Helper for enhanced email validation
const isValidEmail = (email) => {
  // Basic regex validation for email format
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) return false;
  
  // Extract domain from email
  const [, domain] = email.split('@');
  
  // Check if domain is in excluded list
  if (CONFIG.emailValidation.excludeDomains.includes(domain)) return false;
  
  // Check if domain is a common disposable email domain
  if (CONFIG.emailValidation.excludeDisposable && disposableEmailDomains.has(domain)) {
    return false;
  }
  
  return true;
};

// Helper to extract emails from text with improved detection
const extractEmailsFromText = (text) => {
  if (!text) return [];
  
  // Standard email pattern
  const standardEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  
  // Find emails in standard format
  const standardEmails = text.match(standardEmailRegex) || [];
  
  // Look for common email obfuscation patterns
  const obfuscatedText = text.replace(/\s*\(at\)\s*/g, '@')
                              .replace(/\s*\[at\]\s*/g, '@')
                              .replace(/\s*\{at\}\s*/g, '@')
                              .replace(/\s*\(dot\)\s*/g, '.')
                              .replace(/\s*\[dot\]\s*/g, '.')
                              .replace(/\s*\{dot\}\s*/g, '.');
  
  // Extract from de-obfuscated text
  const deobfuscatedEmails = obfuscatedText.match(standardEmailRegex) || [];
  
  // Find HTML encoded emails (e.g., &#64; for @)
  let decodedText = text;
  try {
    // Decode HTML entities
    decodedText = decodedText.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
    // Replace common HTML entity names
    decodedText = decodedText.replace(/&amp;/g, '&')
                             .replace(/&lt;/g, '<')
                             .replace(/&gt;/g, '>')
                             .replace(/&quot;/g, '"')
                             .replace(/&#39;/g, "'");
  } catch (error) {
    logToFile(`Error decoding HTML entities: ${error.message}`, 'ERROR');
  }
  
  const decodedEmails = decodedText.match(standardEmailRegex) || [];
  
  // Look for email addresses with "mailto:" links
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const mailtoMatches = text.match(mailtoRegex) || [];
  const mailtoEmails = mailtoMatches.map(match => match.replace('mailto:', ''));
  
  // Combine all found emails
  const allEmails = [...new Set([
    ...standardEmails,
    ...deobfuscatedEmails,
    ...decodedEmails,
    ...mailtoEmails
  ])];
  
  // Validate and return unique emails
  return allEmails.filter(isValidEmail);
};

// Helper to check MX records for email domain validation
const hasMxRecord = async (domain) => {
  return new Promise((resolve) => {
    const dnsPromises = require('dns').promises;
    
    dnsPromises.resolveMx(domain)
      .then(addresses => {
        resolve(addresses && addresses.length > 0);
      })
      .catch(() => {
        resolve(false);
      });
  });
};

// Enhanced logging with log levels
const logToFile = (message, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  
  // Only show debug messages if debug mode is enabled
  if (level === 'DEBUG' && !CONFIG.debug) {
    return;
  }
  
  console.log(`[${level}] ${message}`);
  fs.appendFileSync(CONFIG.logFile, logMessage);
};

// Helper to sanitize and normalize URLs
const normalizeUrl = (url, baseUrl) => {
  try {
    // Handle relative URLs
    let normalizedUrl = url;
    
    // Check if URL is relative
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      const base = new URL(baseUrl);
      
      // Handle URLs that start with //
      if (url.startsWith('//')) {
        normalizedUrl = `${base.protocol}${url}`;
      } 
      // Handle URLs that start with /
      else if (url.startsWith('/')) {
        normalizedUrl = `${base.protocol}//${base.host}${url}`;
      } 
      // Handle URLs that don't start with /
      else {
        // Get the path without the filename
        let path = base.pathname;
        if (!path.endsWith('/')) {
          path = path.substring(0, path.lastIndexOf('/') + 1);
        }
        normalizedUrl = `${base.protocol}//${base.host}${path}${url}`;
      }
    }
    
    // Create URL object for further normalization
    const urlObj = new URL(normalizedUrl);
    
    // Remove fragments
    urlObj.hash = '';
    
    // Remove certain query parameters that might create duplicate content
    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'fbclid', 'gclid'];
    const params = new URLSearchParams(urlObj.search);
    paramsToRemove.forEach(param => {
      params.delete(param);
    });
    
    // Update search part
    urlObj.search = params.toString();
    
    // Handle trailing slashes consistently
    let finalUrl = urlObj.toString();
    
    // Remove trailing slash for consistency, except for root URLs
    if (finalUrl.endsWith('/') && urlObj.pathname !== '/') {
      finalUrl = finalUrl.slice(0, -1);
    }
    
    return finalUrl;
  } catch (error) {
    logToFile(`Error normalizing URL ${url}: ${error.message}`, 'ERROR');
    return url; // Return original URL if normalization fails
  }
};

// Helper to fetch and parse robots.txt
const fetchRobotsTxt = async (domain) => {
  // Check if we already have it cached
  if (robotsTxtCache.has(domain)) {
    return robotsTxtCache.get(domain);
  }
  
  const robotsUrl = `https://${domain}/robots.txt`;
  
  try {
    // Fetch the robots.txt file
    const response = await new Promise((resolve, reject) => {
      https.get(robotsUrl, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Status code: ${res.statusCode}`));
        }
        
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          resolve(data);
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
    
    // Parse the robots.txt content
    const robots = robotsParser(robotsUrl, response);
    robotsTxtCache.set(domain, robots);
    return robots;
  } catch (error) {
    // If we can't fetch robots.txt, create a permissive one
    logToFile(`Could not fetch robots.txt for ${domain}: ${error.message}`, 'WARN');
    const robots = robotsParser(robotsUrl, '');
    robotsTxtCache.set(domain, robots);
    return robots;
  }
};

// Helper to check if we can crawl a URL according to robots.txt
const canCrawl = async (url) => {
  if (!CONFIG.respectRobotsTxt) return true;
  
  const domain = getDomainFromUrl(url);
  if (!domain) return false;
  
  try {
    const robots = await fetchRobotsTxt(domain);
    return robots.isAllowed(url, 'PuppeteerEmailScraper');
  } catch (error) {
    logToFile(`Error checking robots.txt for ${url}: ${error.message}`, 'WARN');
    return true; // If there's an error, we'll be permissive
  }
};

// Helper to check rate limits for a domain
const checkRateLimit = async (domain) => {
  if (!visitedDomains.has(domain)) {
    visitedDomains.set(domain, {
      count: 0,
      timestamps: [],
      lastVisit: 0
    });
    return true;
  }
  
  const domainData = visitedDomains.get(domain);
  const now = Date.now();
  
  // Check if we've reached the max pages limit
  if (domainData.count >= CONFIG.maxPagesPerDomain) {
    return false;
  }
  
  // Check rate limiting
  const oneMinuteAgo = now - 60 * 1000;
  
  // Remove timestamps older than one minute
  domainData.timestamps = domainData.timestamps.filter(time => time > oneMinuteAgo);
  
  // Check if we're exceeding rate limits
  if (domainData.timestamps.length >= CONFIG.requestsPerMinutePerDomain) {
    // Calculate how long to wait
    const oldestTimestamp = domainData.timestamps[0];
    const waitTime = 60 * 1000 - (now - oldestTimestamp) + 100; // Add 100ms buffer
    
    logToFile(`Rate limit reached for ${domain}, waiting ${waitTime}ms`, 'INFO');
    await sleep(waitTime);
  }
  
  // Enforce minimum delay between requests to same domain
  const timeSinceLastVisit = now - domainData.lastVisit;
  if (timeSinceLastVisit < CONFIG.crawlDelay) {
    const waitTime = CONFIG.crawlDelay - timeSinceLastVisit;
    await sleep(waitTime);
  }
  
  // Update domain data
  domainData.count++;
  domainData.timestamps.push(now);
  domainData.lastVisit = now;
  visitedDomains.set(domain, domainData);
  
  return true;
};

// Helper to save emails to CSV with enhanced metadata
const saveEmailsToCsv = async (emails) => {
  const csvWriter = createObjectCsvWriter({
    path: CONFIG.outputFile,
    header: [
      { id: 'email', title: 'Email' },
      { id: 'domain', title: 'Domain' },
      { id: 'source', title: 'Source URL' },
      { id: 'sourceDomain', title: 'Source Domain' },
      { id: 'timestamp', title: 'Timestamp' },
      { id: 'pageTitle', title: 'Page Title' },
      { id: 'contextText', title: 'Context Text' }
    ]
  });
  
  await csvWriter.writeRecords(emails);
  logToFile(`Saved ${emails.length} emails to ${CONFIG.outputFile}`, 'INFO');
};

// Function to take a screenshot for debugging
const captureErrorScreenshot = async (page, url) => {
  if (!CONFIG.captureScreenshotOnError) return;
  
  try {
    // Create screenshot directory if it doesn't exist
    if (!fs.existsSync(CONFIG.screenshotDir)) {
      fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    }
    
    // Create a filename based on the URL
    const domain = getDomainFromUrl(url) || 'unknown';
    const timestamp = Date.now();
    const filename = path.join(CONFIG.screenshotDir, `error_${domain}_${timestamp}.png`);
    
    await page.screenshot({ path: filename, fullPage: false });
    logToFile(`Error screenshot saved to ${filename}`, 'INFO');
  } catch (error) {
    logToFile(`Failed to capture error screenshot: ${error.message}`, 'ERROR');
  }
};

// Function to extract emails from a page with improved context capturing
const extractEmailsFromPage = async (page, url) => {
  try {
    // Get page title
    const pageTitle = await page.title();
    
    // Extract text content from the page
    const bodyText = await page.evaluate(() => document.body.innerText);
    
    // Extract HTML content for encoded emails
    const htmlContent = await page.content();
    
    // Extract emails from visible text
    const emailsFromText = extractEmailsFromText(bodyText);
    
    // Look for emails in HTML that might be encoded or in attributes
    const emailsFromHtml = extractEmailsFromText(htmlContent);
    
    // Extract emails from specific elements like contact forms, mailto links, etc.
    const emailsFromElements = await page.evaluate(() => {
      const results = [];
      
      // Check mailto links
      document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
        const email = link.href.replace('mailto:', '').split('?')[0].trim();
        if (email) results.push({ 
          email, 
          context: link.innerText || link.textContent || 'Mailto Link'
        });
      });
      
      // Check input fields with email type or name/id containing "email"
      document.querySelectorAll('input[type="email"], input[name*="email"], input[id*="email"]').forEach(input => {
        const email = input.value;
        if (email && email.includes('@')) {
          let labelText = '';
          
          // Try to find associated label
          const id = input.id;
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) labelText = label.innerText || label.textContent;
          }
          
          results.push({ 
            email, 
            context: labelText || 'Input Field' 
          });
        }
      });
      
      // Look for contact information sections
      ['contact', 'footer', 'about', 'team'].forEach(section => {
        document.querySelectorAll(`div[id*="${section}"], div[class*="${section}"], section[id*="${section}"], section[class*="${section}"]`).forEach(element => {
          const text = element.innerText || element.textContent;
          if (!text) return;
          
          // Simple email regex for client-side detection
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const matches = text.match(emailRegex);
          
          if (matches) {
            matches.forEach(email => {
              // Get some surrounding text for context
              const sentences = text.split(/[.!?]+/);
              let contextSentence = '';
              
              for (const sentence of sentences) {
                if (sentence.includes(email)) {
                  contextSentence = sentence.trim();
                  break;
                }
              }
              
              results.push({ 
                email, 
                context: contextSentence || text.substring(0, 100) 
              });
            });
          }
        });
      });
      
      return results;
    });
    
    // Combine all emails
    const allEmailsWithContext = new Map();
    
    // Process emails from text
    emailsFromText.forEach(email => {
      // Find context for this email in the body text
      const sentences = bodyText.split(/[.!?]+/);
      let context = '';
      
      for (const sentence of sentences) {
        if (sentence.includes(email)) {
          context = sentence.trim();
          break;
        }
      }
      
      allEmailsWithContext.set(email, {
        email,
        context: context || 'Found in page text'
      });
    });
    
    // Process emails from HTML
    emailsFromHtml.forEach(email => {
      if (!allEmailsWithContext.has(email)) {
        allEmailsWithContext.set(email, {
          email,
          context: 'Found in HTML source'
        });
      }
    });
    
    // Process emails from elements
    emailsFromElements.forEach(({ email, context }) => {
      if (!allEmailsWithContext.has(email)) {
        allEmailsWithContext.set(email, { email, context });
      }
    });
    
    // Process each email
    const domain = getDomainFromUrl(url);
    const sourceDomain = getDomainFromUrl(url);
    const timestamp = new Date().toISOString();
    
    const results = [];
    
    for (const [email, data] of allEmailsWithContext.entries()) {
      if (!extractedEmails.has(email)) {
        extractedEmails.add(email);
        logToFile(`Found email: ${email} from ${url}`, 'INFO');
      }
      
      const emailDomain = email.split('@')[1];
      
      results.push({
        email,
        domain: emailDomain,
        source: url,
        sourceDomain,
        timestamp,
        pageTitle,
        contextText: data.context
      });
    }
    
    return results;
  } catch (error) {
    logToFile(`Error extracting emails from ${url}: ${error.message}`, 'ERROR');
    return [];
  }
};

// Function to get all links from a page with intelligent filtering
const getAllLinks = async (page, baseUrl) => {
  try {
    const baseDomain = getDomainFromUrl(baseUrl);
    
    // Get all links on the page
    const links = await page.evaluate(baseDomain => {
      const allLinks = [];
      
      // Get regular links
      document.querySelectorAll('a[href]').forEach(a => {
        if (a.href && a.href.startsWith('http')) {
          // Get link text for relevance scoring
          const linkText = (a.innerText || a.textContent || '').trim().toLowerCase();
          
          // Calculate relevance score
          let relevanceScore = 0;
          
          // Higher score for contact-related links
          if (['contact', 'about', 'team', 'staff', 'people', 'directory', 'faculty'].some(term => 
              linkText.includes(term) || a.href.toLowerCase().includes(term))) {
            relevanceScore += 10;
          }
          
          // Higher score for links in the main navigation, header, or footer
          const parents = [a.parentElement, a.parentElement?.parentElement, a.parentElement?.parentElement?.parentElement];
          if (parents.some(parent => {
            if (!parent) return false;
            const parentClasses = parent.className.toLowerCase();
            const parentId = (parent.id || '').toLowerCase();
            return ['nav', 'menu', 'header', 'footer'].some(term => 
              parentClasses.includes(term) || parentId.includes(term));
          })) {
            relevanceScore += 5;
          }
          
          allLinks.push({
            url: a.href,
            text: linkText,
            relevance: relevanceScore
          });
        }
      });
      
      return allLinks;
    }, baseDomain);
    
    // Normalize and filter links
    const processedLinks = links.map(link => ({
      ...link,
      url: normalizeUrl(link.url, baseUrl)
    }));
    
    // Separate internal and external links
    const internalLinks = [];
    const externalLinks = [];
    
    for (const link of processedLinks) {
      const linkDomain = getDomainFromUrl(link.url);
      
      if (linkDomain === baseDomain) {
        internalLinks.push(link);
      } else {
        externalLinks.push(link);
      }
    }
    
    // Sort internal links by relevance
    internalLinks.sort((a, b) => b.relevance - a.relevance);
    
    return {
      internal: internalLinks.map(link => link.url),
      external: externalLinks.map(link => link.url)
    };
  } catch (error) {
    logToFile(`Error getting links from ${baseUrl}: ${error.message}`, 'ERROR');
    return { internal: [], external: [] };
  }
};

// Main crawling function with improved error handling and retry logic
const crawlPage = async (browser, url, depth = 0, retryCount = 0) => {
  const maxRetries = 2;
  
  if (depth > CONFIG.maxDepth || processedUrls.has(url)) {
    return [];
  }
  
  const domain = getDomainFromUrl(url);
  if (!domain) {
    logToFile(`Invalid URL: ${url}`, 'ERROR');
    return [];
  }
  
  // Check robots.txt compliance
  const crawlAllowed = await canCrawl(url);
  if (!crawlAllowed) {
    logToFile(`Crawling not allowed by robots.txt: ${url}`, 'INFO');
    return [];
  }
  
  // Check rate limits
  const rateLimitOk = await checkRateLimit(domain);
  if (!rateLimitOk) {
    logToFile(`Rate limit or max pages reached for domain ${domain}`, 'INFO');
    return [];
  }
  
  processedUrls.add(url);
  logToFile(`Crawling (depth ${depth}): ${url}`, 'INFO');
  
  let page;
  try {
    page = await browser.newPage();
    
    // Set random user agent
    await page.setUserAgent(getRandomUserAgent());
    
    // Set viewport
    await page.setViewport({
      width: 1920,
      height: 1080
    });
    
    // Set extra HTTP headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    });
    
    // Enable JavaScript errors logging
    page.on('console', msg => {
      if (CONFIG.debug && msg.type() === 'error') {
        logToFile(`Console error on ${url}: ${msg.text()}`, 'DEBUG');
      }
    });
    
    // Set longer timeout
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);
    
    // Navigate to the URL with timeout
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: CONFIG.pageTimeout
    });
    
    // Wait a bit for any JavaScript to execute
    await sleep(1000);
    
    // Extract emails from the current page
    const foundEmails = await extractEmailsFromPage(page, url);
    
    // If we haven't reached max depth, crawl internal links
    let emailsFromInternalLinks = [];
    if (depth < CONFIG.maxDepth) {
      // Get all links
      const { internal: internalLinks } = await getAllLinks(page, url);
      
      // Filter out already processed URLs
      const newLinks = internalLinks.filter(link => !processedUrls.has(link));
      
      // Sort links by potential relevance
      const sortedLinks = newLinks.sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        
        // Prioritize links that might contain contact information
        const contactTerms = ['contact', 'about', 'team', 'staff', 'people', 'directory'];
        
        const aHasContactTerm = contactTerms.some(term => aLower.includes(term));
        const bHasContactTerm = contactTerms.some(term => bLower.includes(term));
        
        if (aHasContactTerm && !bHasContactTerm) return -1;
        if (!aHasContactTerm && bHasContactTerm) return 1;
        
        return 0;
      });
      
      // Limit number of links to follow from each page
      const linksToFollow = sortedLinks.slice(0, 10);
      
      // Recursively crawl each internal link
      for (const link of linksToFollow) {
        // Wait before crawling the next page to respect crawl delay
        await sleep(CONFIG.crawlDelay);
        
        const nestedEmails = await crawlPage(browser, link, depth + 1);
        emailsFromInternalLinks = [...emailsFromInternalLinks, ...nestedEmails];
      }
    }
    
    return [...foundEmails, ...emailsFromInternalLinks];
  } catch (error) {
    logToFile(`Error crawling ${url}: ${error.message}`, 'ERROR');
    
    // Take screenshot on error if enabled
    if (page) {
      await captureErrorScreenshot(page, url);
    }
    
    // Retry logic
    if (retryCount < maxRetries) {
      logToFile(`Retrying ${url} (attempt ${retryCount + 1}/${maxRetries})`, 'INFO');
      await sleep(2000);
      return crawlPage(browser, url, depth, retryCount + 1);
    }
    
    return [];
  } finally {
    if (page) {
      await page.close().catch(err => {
        logToFile(`Error closing page: ${err.message}`, 'WARN');
      });
    }
  }
};

// Main function to start the crawling process
const startCrawling = async (urlList) => {
  try {
    // Create log file directory if it doesn't exist
    const logDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Clear previous log
    fs.writeFileSync(CONFIG.logFile, '');
    
    logToFile(`Starting email scraper with ${urlList.length} URLs`, 'INFO');
    logToFile(`Max concurrency: ${CONFIG.maxConcurrency}`, 'INFO');
    logToFile(`Max depth: ${CONFIG.maxDepth}`, 'INFO');
    logToFile(`Respect robots.txt: ${CONFIG.respectRobotsTxt}`, 'INFO');
    
    // Launch browsers with concurrency control
    const allEmails = [];
    const urlBatches = [];
    
    // Split URLs into batches for concurrency
    for (let i = 0; i < urlList.length; i += CONFIG.maxConcurrency) {
      urlBatches.push(urlList.slice(i, i + CONFIG.maxConcurrency));
    }
    
    // Process each batch
    for (const batch of urlBatches) {
      logToFile(`Processing batch of ${batch.length} URLs`, 'INFO');
      
      // Launch browsers for this batch
      const browsers = await Promise.all(
        batch.map(async () => {
          const proxy = getNextProxy();
          const browserOptions = {
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--disable-gpu',
              '--window-size=1920,1080'
            ]
          };
          
          // Add proxy if configured
          if (proxy) {
            browserOptions.args.push(`--proxy-server=${proxy.server}`);
          }
          
          return puppeteer.launch(browserOptions);
        })
      );
      
      // Start crawling each URL in the batch
      const batchPromises = batch.map(async (url, index) => {
        const browser = browsers[index];
        try {
          // Authenticate proxy if needed
          if (CONFIG.useProxies) {
            const proxy = CONFIG.proxies[index % CONFIG.proxies.length];
            if (proxy.username && proxy.password) {
              const page = await browser.newPage();
              await page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
              });
              await page.close();
            }
          }
          
          // Start crawling
          return await crawlPage(browser, url);
        } catch (error) {
          logToFile(`Error processing ${url}: ${error.message}`, 'ERROR');
          return [];
        } finally {
          // Close browser
          await browser.close().catch(err => {
            logToFile(`Error closing browser: ${err.message}`, 'WARN');
          });
        }
      });
      
      // Wait for all URLs in this batch to be processed
      const batchResults = await Promise.all(batchPromises);
      
      // Collect emails from this batch
      batchResults.forEach(emails => {
        allEmails.push(...emails);
      });
      
      // Wait before processing the next batch
      if (urlBatches.indexOf(batch) < urlBatches.length - 1) {
        logToFile('Waiting between batches...', 'INFO');
        await sleep(5000);
      }
    }
    
    // Save results
    logToFile(`Crawling complete. Found ${extractedEmails.size} unique emails.`, 'INFO');
    await saveEmailsToCsv(allEmails);
    
    return { success: true, emailCount: extractedEmails.size };
  } catch (error) {
    logToFile(`Fatal error: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
};

// Read URLs from a file
const readUrlsFromFile = (filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Split by new line and filter out empty lines or comments
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(url => {
        // Add protocol if missing
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return `https://${url}`;
        }
        return url;
      });
  } catch (error) {
    logToFile(`Error reading URLs from file: ${error.message}`, 'ERROR');
    return [];
  }
};

// Command line interface
const main = async () => {
  // Check for command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node email-scraper.js <url-file> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --output=<file>          Output CSV file (default: extracted_emails.csv)');
    console.log('  --concurrency=<number>   Maximum concurrent browsers (default: 5)');
    console.log('  --depth=<number>         Maximum crawl depth (default: 3)');
    console.log('  --delay=<number>         Delay between requests in ms (default: 1500)');
    console.log('  --timeout=<number>       Page load timeout in ms (default: 45000)');
    console.log('  --max-pages=<number>     Maximum pages per domain (default: 50)');
    console.log('  --no-robots              Ignore robots.txt');
    console.log('  --debug                  Enable debug logging');
    console.log('  --with-proxies           Enable proxy usage');
    console.log('');
    return;
  }
  
  const urlFile = args[0];
  
  // Parse options
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--output=')) {
      CONFIG.outputFile = arg.split('=')[1];
    } else if (arg.startsWith('--concurrency=')) {
      CONFIG.maxConcurrency = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--depth=')) {
      CONFIG.maxDepth = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--delay=')) {
      CONFIG.crawlDelay = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--timeout=')) {
      CONFIG.pageTimeout = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--max-pages=')) {
      CONFIG.maxPagesPerDomain = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--no-robots') {
      CONFIG.respectRobotsTxt = false;
    } else if (arg === '--debug') {
      CONFIG.debug = true;
    } else if (arg === '--with-proxies') {
      CONFIG.useProxies = true;
    }
  }
  
  // Create screenshot directory if enabled
  if (CONFIG.captureScreenshotOnError) {
    if (!fs.existsSync(CONFIG.screenshotDir)) {
      fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    }
  }
  
  console.log(`Reading URLs from ${urlFile}`);
  const urls = readUrlsFromFile(urlFile);
  
  if (urls.length === 0) {
    console.error('No valid URLs found in the input file.');
    return;
  }
  
  console.log(`Starting to crawl ${urls.length} URLs...`);
  const result = await startCrawling(urls);
  
  if (result.success) {
    console.log(`Crawling completed successfully. Found ${result.emailCount} unique emails.`);
    console.log(`Results saved to ${CONFIG.outputFile}`);
    console.log(`Log file saved to ${CONFIG.logFile}`);
  } else {
    console.error(`Crawling failed: ${result.error}`);
  }
};

// Run the script
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});