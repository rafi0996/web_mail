// email-scraper-server.js
import express from "express";
import puppeteer from "puppeteer-core";
import cors from "cors";
import { URL } from "url";
import robotsParser from "robots-parser";
import path from "path";
import fetch from "node-fetch";

const app = express();
const PORT = 5000;


// API Configuration
const API_BASE_URL = ""; // Empty string for same-origin, or specify full URL if needed

// Replace your current startBrowser and browser launch functions with this:

async function startBrowser() {
  // Default Chrome locations for different environments
  const possibleChromePaths = [
    // Render.com
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    // Replit
    '/nix/store/x205pbkd5xh5g4iv0g58xjla55has3cx-chromium-108.0.5359.94/bin/chromium',
    // Default fallback
    process.env.CHROME_PATH,
  ];

  // Find first existing Chrome executable
  let executablePath = null;
  for (const path of possibleChromePaths) {
    if (path && require('fs').existsSync(path)) {
      executablePath = path;
      console.log(`Found Chrome at: ${executablePath}`);
      break;
    }
  }

  const launchOptions = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    headless: true
  };

  // Add executablePath if found
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  try {
    const browser = await puppeteer.launch(launchOptions);
    console.log("Browser launched successfully");
    return browser;
  } catch (error) {
    console.error("Error launching browser:", error.message);
    
    // Try launching without executablePath as a fallback
    if (executablePath) {
      console.log("Retrying browser launch without specific executablePath");
      delete launchOptions.executablePath;
      return puppeteer.launch(launchOptions);
    } else {
      throw error;
    }
  }
}

// Also replace the browser launch in your scrape endpoint with:
const browser = await startBrowser();


// Middleware
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Set up public directory for frontend files
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

// Store active scraping jobs
const activeJobs = new Map();
let nextJobId = 1;

// Domain rate limiting
const domainLastAccess = new Map();

// Job cleanup interval (clear completed jobs older than 2 hours)
const JOB_CLEANUP_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
const JOB_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of activeJobs.entries()) {
    // Remove completed jobs older than JOB_MAX_AGE
    if (job.progress === 100 && now - job.started > JOB_MAX_AGE) {
      activeJobs.delete(jobId);
      console.log(`Cleaned up completed job ${jobId}`);
    }
  }
}, JOB_CLEANUP_INTERVAL);

// Helper function to extract emails from text
function extractEmails(text) {
  // More specific email regex that avoids version numbers
  const emailRegex =
    /([a-zA-Z0-9][\w.-]*[a-zA-Z0-9]@[a-zA-Z0-9][\w.-]*\.[a-zA-Z]{2,})/gi;
  const potentialEmails = text.match(emailRegex) || [];

  // Filter out likely invalid emails
  const validEmails = potentialEmails.filter((email) => {
    // Filter out emails that look like version numbers
    if (/^[a-zA-Z-]+@\d+\.\d+\.\d+$/.test(email)) {
      return false;
    }

    // Filter out technical service domains and error IDs
    const emailDomain = email.split("@")[1].toLowerCase();
    const username = email.split("@")[0];

    // Filter out domains that are known technical services
    const technicalDomains = [
      "sentry.wixpress.com",
      "sentry-next.wixpress.com",
      "sentry.io",
    ];

    if (technicalDomains.includes(emailDomain)) {
      return false;
    }

    // Filter out emails with very long usernames (likely identifiers/hashes)
    if (username.length > 30) {
      return false;
    }

    // Exclude emails where username is entirely numeric or looks like a hash
    if (/^\d+$/.test(username) || /^[a-f0-9]{24,}$/i.test(username)) {
      return false;
    }

    return true;
  });

  return [...new Set(validEmails)]; // Remove duplicates
}

// Validate found emails
function isLikelyValidEmail(email) {
  // Basic structure validation
  if (!email.includes("@") || !email.includes(".")) return false;

  const [username, domain] = email.split("@");

  // Check username quality
  if (username.length < 2) return false;
  if (username.length > 64) return false;

  // Filter out image file names and timestamps
  if (domain.match(/(_ts\d+|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|\.ico)$/i))
    return false;

  // Filter out version numbers like 2x, 3x in filenames
  if (domain.match(/^\d+x\./i)) return false;

  // Check domain quality
  if (domain.length < 3) return false;
  if (!domain.includes(".")) return false;

  // Check TLD validity (at least 2 chars, not just numbers)
  const tld = domain.split(".").pop();
  if (tld.length < 2 || tld.match(/^\d+$/)) return false;

  // Blacklist common non-email domains
  const blacklistedDomains = [
    "sentry.io",
    "sentry.wixpress.com",
    "sentry-next.wixpress.com",
    "localhost",
    "example.com",
    "test.com",
    "domain.com",
    "email.com",
    "your-domain.com",
  ];

  if (blacklistedDomains.some((d) => domain.includes(d))) {
    return false;
  }

  return true;
}

// Helper function to check robots.txt
async function checkRobotsTxt(url, respectRobots) {
  if (!respectRobots) return true;

  try {
    const parsedUrl = new URL(url);
    const robotsUrl = `${parsedUrl.protocol}//${parsedUrl.host}/robots.txt`;

    const response = await fetch(robotsUrl, {
      timeout: 5000, // 5 second timeout
      headers: {
        "User-Agent": "EmailScraper/1.0",
      },
    });

    if (!response.ok) return true; // If no robots.txt or error, assume allowed

    const robotsTxt = await response.text();
    const robots = robotsParser(robotsUrl, robotsTxt);

    return robots.isAllowed(url, "EmailScraper");
  } catch (error) {
    console.error("Error checking robots.txt:", error);
    return true; // If error, assume allowed
  }
}

// Handle domain rate limiting
async function respectDomainRateLimit(domain, crawlDelay) {
  const now = Date.now();

  // Get the last access time for this domain
  const lastAccess = domainLastAccess.get(domain) || 0;
  const timeToWait = Math.max(0, lastAccess + crawlDelay - now);

  // Wait if necessary
  if (timeToWait > 0) {
    await new Promise((resolve) => setTimeout(resolve, timeToWait));
  }

  // Update last access time
  domainLastAccess.set(domain, Date.now());
}

// Function to crawl a URL using Puppeteer
async function crawlUrl(
  browser,
  url,
  config,
  depth = 0,
  domainStats = {},
  jobId
) {
  const job = activeJobs.get(jobId);
  if (!job || job.stopped) return [];

  // Skip if max depth reached or URL already processed
  if (depth > config.maxDepth || job.processedUrls.has(url)) {
    return [];
  }

  // Parse URL to get domain and path
  let domain;
  let path;
  try {
    const parsedUrl = new URL(url);
    domain = parsedUrl.hostname;
    path = parsedUrl.pathname.toLowerCase();
  } catch (error) {
    job.log("ERROR", `Invalid URL: ${url}`);
    return [];
  }

  // Track domain stats
  if (!domainStats[domain]) {
    domainStats[domain] = { pages: 0 };
  }

  // Check if we've reached max pages for this domain
  if (domainStats[domain].pages >= config.maxPagesPerDomain) {
    job.log("DEBUG", `Skipping ${url}: Max pages reached for domain ${domain}`);
    return [];
  }

  // Respect domain rate limit
  await respectDomainRateLimit(domain, config.crawlDelay);

  // Check robots.txt
  const allowed = await checkRobotsTxt(url, config.respectRobotsTxt);
  if (!allowed) {
    job.log("INFO", `Skipping ${url}: Not allowed by robots.txt`);
    return [];
  }

  // Mark URL as processed
  job.processedUrls.add(url);

  // Prioritize contact-related paths at depth 0
  const isPriorityPage = [
    "/contact",
    "/about",
    "/about-us",
    "/team",
    "/staff",
    "/support",
    "/help",
    "/customer-service",
    "/privacy",
  ].some(
    (contactPath) =>
      path.includes(contactPath) || path.endsWith(contactPath + ".html")
  );

  if (isPriorityPage) {
    job.log("INFO", `Crawling priority page (depth ${depth}): ${url}`);
  } else {
    job.log("INFO", `Crawling (depth ${depth}): ${url}`);
  }

  // Increment pages for this domain
  domainStats[domain].pages++;

  try {
    // Create a new page
    const page = await browser.newPage();

    // Set timeout
    await page.setDefaultNavigationTimeout(config.pageTimeout);

    // Configure browser settings
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36"
    );

    // Security and privacy settings
    await page.setJavaScriptEnabled(true);
    await page.setRequestInterception(true);

    // Block unnecessary resources to speed up crawling
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Use proxy if configured
    if (config.useProxies && config.proxies && config.proxies.length > 0) {
      const proxyIndex = Math.floor(Math.random() * config.proxies.length);
      const proxy = config.proxies[proxyIndex];

      if (proxy.server) {
        // Set up authentication if provided
        if (proxy.username && proxy.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          });
        }

        // Actually configure the proxy for the browser
        // This needs to be done via puppeteer launch args, which would require setting up
        // a new browser instance per proxy, which is not practical.
        // Instead, we're authenticating but you would need to launch puppeteer with
        // appropriate proxy flags for full proxy support
      }
    }

    // Navigation options
    const navigationOptions = {
      waitUntil: "domcontentloaded",
      timeout: config.pageTimeout,
    };

    // Navigate to URL with retry logic
    let navigationSuccess = false;
    let retryCount = 0;
    while (!navigationSuccess && retryCount < 2) {
      try {
        await page.goto(url, navigationOptions);
        navigationSuccess = true;
      } catch (navError) {
        retryCount++;
        if (retryCount >= 2) {
          throw navError;
        }
        job.log("WARN", `Navigation failed, retrying (${retryCount}): ${url}`);
        await new Promise((r) => setTimeout(r, 1000)); // Wait 1 second before retry
      }
    }

    // Get page title
    const pageTitle = await page.title();

    // Extract emails using both text and HTML methods for better coverage
    const pageText = await page.evaluate(() => document.body.innerText);
    const pageHtml = await page.evaluate(
      () => document.documentElement.outerHTML
    );

    // Extract emails from both sources
    const textEmails = extractEmails(pageText);
    const htmlEmails = extractEmails(pageHtml);

    // Combine and deduplicate
    const emails = [...new Set([...textEmails, ...htmlEmails])];

    const foundEmails = [];

    // Process found emails
    for (const email of emails) {
      const emailDomain = email.split("@")[1];

      // Add validation check
      if (!isLikelyValidEmail(email)) {
        job.log("DEBUG", `Skipping unlikely valid email: ${email}`);
        continue;
      }

      if (!job.extractedEmails.has(email)) {
        job.extractedEmails.add(email);

        job.log("INFO", `Found email: ${email} from ${url}`);

        // Get context for email (text around the email)
        const contextText = await page.evaluate((emailToFind) => {
          const bodyText = document.body.innerText;
          const index = bodyText.indexOf(emailToFind);
          if (index === -1) return "";

          const start = Math.max(0, index - 100);
          const end = Math.min(
            bodyText.length,
            index + emailToFind.length + 100
          );
          return bodyText.substring(start, end).replace(/\n+/g, " ").trim();
        }, email);

        foundEmails.push({
          email,
          domain: emailDomain,
          source: url,
          sourceDomain: domain,
          timestamp: new Date().toISOString(),
          pageTitle,
          contextText,
        });

        job.csvData.push({
          email,
          domain: emailDomain,
          source: url,
          sourceDomain: domain,
          timestamp: new Date().toISOString(),
          pageTitle,
          contextText,
        });
      }
    }

    // If no emails found and we're at depth 0 (initial URL)
    if (foundEmails.length === 0 && depth === 0) {
      job.notFoundUrls.add(url);
    }

    // Find all links on the page if not at max depth
    let links = [];
    if (depth < config.maxDepth) {
      links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((a) => a.href)
          .filter((href) => href.startsWith("http"));
      });
    }

    // Close the page
    await page.close();

    // If job was stopped, return what we have so far
    if (job.stopped) {
      return foundEmails;
    }

    // Prioritize contact-related links
    links.sort((a, b) => {
      // Define priority terms
      const priorityTerms = [
        "contact",
        "about",
        "team",
        "staff",
        "support",
        "help",
      ];

      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();

      // Check if either URL contains priority terms
      const aHasPriority = priorityTerms.some((term) => aLower.includes(term));
      const bHasPriority = priorityTerms.some((term) => bLower.includes(term));

      // If one has priority and the other doesn't, prioritize the one that does
      if (aHasPriority && !bHasPriority) return -1;
      if (!aHasPriority && bHasPriority) return 1;

      // Otherwise, keep original order
      return 0;
    });

    // Crawl found links recursively
    const nestedEmails = [];
    for (const link of links) {
      // Skip if already processed or not same domain
      try {
        const linkUrl = new URL(link);
        if (linkUrl.hostname !== domain) continue; // Only follow links on same domain
      } catch {
        continue; // Skip invalid URLs
      }

      // Crawl link
      const linkEmails = await crawlUrl(
        browser,
        link,
        config,
        depth + 1,
        domainStats,
        jobId
      );
      nestedEmails.push(...linkEmails);

      // Update progress
      job.updateProgress();

      // Check if job was stopped
      if (job.stopped) break;
    }

    return [...foundEmails, ...nestedEmails];
  } catch (error) {
    job.log("ERROR", `Error crawling ${url}: ${error.message} at ${url}`);

    // Mark as not found if at depth 0
    if (depth === 0) {
      job.notFoundUrls.add(url);
    }

    return [];
  }
}

// Start scraping endpoint
app.post("/api/scrape/start", async (req, res) => {
  try {
    const { urls, config } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "No valid URLs provided" });
    }

    // Store original URL order for CSV
    const originalUrlOrder = [...new Set(urls)].slice(0, 100);

    // Validate and sanitize config
    const sanitizedConfig = {
      maxConcurrency: Math.min(Number(config.maxConcurrency) || 3, 10),
      maxDepth: Math.min(Number(config.maxDepth) || 2, 5),
      pageTimeout: Math.min(Number(config.pageTimeout) || 30000, 60000),
      crawlDelay: Math.max(Number(config.crawlDelay) || 1000, 500),
      respectRobotsTxt: config.respectRobotsTxt !== false,
      maxPagesPerDomain: Math.min(Number(config.maxPagesPerDomain) || 20, 50),
      useProxies: Boolean(config.useProxies),
      proxies: Array.isArray(config.proxies) ? config.proxies : [],
    };

    const jobId = nextJobId++;

    // Create job object
    const job = {
      id: jobId,
      started: Date.now(),
      config: sanitizedConfig,
      urls: originalUrlOrder, // Use the original order
      processedUrls: new Set(),
      extractedEmails: new Set(),
      csvData: [],
      notFoundUrls: new Set(), // Track URLs without emails
      logs: [],
      stopped: false,
      progress: 0,

      log(level, message) {
        const timestamp = new Date().toISOString();
        this.logs.push({ timestamp, level, message });

        // Limit logs to prevent memory issues
        if (this.logs.length > 1000) {
          this.logs = this.logs.slice(-500);
        }
      },

      updateProgress() {
        // Calculate progress based on processed URLs
        const processed = this.processedUrls.size;
        const total = this.urls.length * 3; // Rough estimate
        this.progress = Math.min(99, Math.floor((processed / total) * 100));
      },
    };

    // Store job
    activeJobs.set(jobId, job);

    // Send initial response
    res.json({ jobId, message: "Scraping started" });

    // Start scraping in background
    try {
      job.log("INFO", `Starting email scraper with ${job.urls.length} URLs`);
      job.log("INFO", `Max concurrency: ${sanitizedConfig.maxConcurrency}`);
      job.log("INFO", `Max depth: ${sanitizedConfig.maxDepth}`);
      job.log(
        "INFO",
        `Respect robots.txt: ${sanitizedConfig.respectRobotsTxt}`
      );

      // Later in your code:
      // const browser = await puppeteer.launch({
      //   executablePath: process.env.CHROME_PATH || "/usr/bin/chromium-browser",
      //   args: ["--no-sandbox", "--disable-setuid-sandbox"],
      // });

      // Launch browser with improved security settings
      const browser = await puppeteer.launch({
        headless: "new",
        executablePath: "/nix/store/x205pbkd5xh5g4iv0g58xjla55has3cx-chromium-108.0.5359.94/bin/chromium",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-accelerated-2d-canvas",
          "--disable-web-security",
          "--window-size=1280,1024",
          "--disable-extensions",
          "--disable-component-extensions-with-background-pages",
          "--disable-default-apps",
          "--mute-audio",
          "--no-zygote",
        ],
        ignoreHTTPSErrors: true,
      });

      // Process URLs in batches
      const batchSize = sanitizedConfig.maxConcurrency;
      const domainStats = {};

      for (let i = 0; i < job.urls.length; i += batchSize) {
        if (job.stopped) break;

        const batch = job.urls.slice(i, i + batchSize);
        job.log("INFO", `Processing batch of ${batch.length} URLs`);

        // Process each URL in the batch concurrently
        await Promise.all(
          batch.map((url) =>
            crawlUrl(browser, url, sanitizedConfig, 0, domainStats, jobId)
          )
        );

        // Update progress
        job.updateProgress();
      }

      // After all URLs are processed, check for URLs where no emails were found
      job.urls.forEach((url) => {
        if (!job.notFoundUrls.has(url) && job.processedUrls.has(url)) {
          // Check if any emails were found for this URL
          const foundEmailsForUrl = job.csvData.some(
            (item) => item.source === url
          );

          if (!foundEmailsForUrl) {
            try {
              const parsedUrl = new URL(url);
              const domain = parsedUrl.hostname;

              // Add a "not found" entry to csvData
              job.csvData.push({
                email: "Not found",
                domain: "Not found",
                source: url,
                sourceDomain: domain,
                timestamp: new Date().toISOString(),
                pageTitle: "N/A",
                contextText: "No email found on this website",
              });

              job.notFoundUrls.add(url);
              job.log("INFO", `No emails found for ${url}`);
            } catch (urlError) {
              job.log("ERROR", `Invalid URL when processing not found: ${url}`);
            }
          }
        }
      });

      // Finish job
      job.progress = 100;
      job.log(
        "INFO",
        `Website crawling completed. Found ${job.extractedEmails.size} email addresses across ${job.processedUrls.size} URLs.`
      );

      // Close browser
      await browser.close();
    } catch (error) {
      job.log("ERROR", `Scraping error: ${error.message}`);
      console.error("Scraping error:", error);
    }
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Stop scraping endpoint
app.post("/api/scrape/stop/:jobId", (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const job = activeJobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    job.stopped = true;
    job.log("INFO", "Scraping stopped by user");

    res.json({ message: "Scraping stopped" });
  } catch (error) {
    console.error("Error stopping job:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get job status endpoint
app.get("/api/scrape/status/:jobId", (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const job = activeJobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Get latest logs
    const latestLogs = job.logs.slice(-100);

    res.json({
      id: job.id,
      progress: job.progress,
      emails: Array.from(job.extractedEmails),
      processedUrls: job.processedUrls.size,
      logs: latestLogs,
      csvData: job.csvData.slice(0, 1000), // Limit data size
      stopped: job.stopped,
    });
  } catch (error) {
    console.error("Error getting status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Download CSV endpoint
app.get("/api/scrape/download/:jobId", (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId);
    const job = activeJobs.get(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Create CSV content
    const headers = [
      "Email",
      "Domain",
      "Source URL",
      "Source Domain",
      "Timestamp",
      "Page Title",
      "Context Text",
    ];
    let csvContent = headers.join(",") + "\n";

    // Create a map of URLs to their email findings
    const urlEmailMap = new Map();
    job.csvData.forEach((item) => {
      if (!urlEmailMap.has(item.source)) {
        urlEmailMap.set(item.source, []);
      }
      urlEmailMap.get(item.source).push(item);
    });

    // Add "not found" entries for URLs without emails
    job.urls.forEach((url) => {
      if (!urlEmailMap.has(url) && job.processedUrls.has(url)) {
        const parsedUrl = new URL(url);
        const domain = parsedUrl.hostname;

        // Add a "not found" entry
        urlEmailMap.set(url, [
          {
            email: "Not found",
            domain: "Not found",
            source: url,
            sourceDomain: domain,
            timestamp: new Date().toISOString(),
            pageTitle: "N/A",
            contextText: "No email found on this website",
          },
        ]);
      }
    });

    // Generate CSV maintaining original URL order
    job.urls.forEach((url) => {
      const entries = urlEmailMap.get(url) || [];
      entries.forEach((item) => {
        // Sanitize CSV values
        const sanitizedValues = [
          item.email,
          item.domain,
          item.source,
          item.sourceDomain,
          item.timestamp,
          (item.pageTitle || "").replace(/[,"']/g, " "),
          (item.contextText || "")
            .replace(/[,"']/g, " ")
            .replace(/[\r\n]/g, " "),
        ].map((value) => `"${(value || "").replace(/"/g, '""')}"`);

        csvContent += sanitizedValues.join(",") + "\n";
      });
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=extracted_emails.csv"
    );
    res.send(csvContent);
  } catch (error) {
    console.error("Error downloading CSV:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Serve the frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Email scraper server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  // Keep server running despite uncaught exceptions
});

// Handle 404s - redirect to homepage
app.use((req, res) => {
  res.redirect("/");
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.get("/ping", (req, res) => {
  res.send("Pong!");
});

app.listen(5000, () => {
  console.log("Server is running on http://0.0.0.0:5000");
});
