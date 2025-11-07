#!/usr/bin/env node
// Stealth-enabled Puppeteer
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";


// Activate stealth before anything else
puppeteer.use(StealthPlugin());

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */
const SEARCH_TERMS = ["cancel", "close", "dismiss", "Later",  "reject", "decline", "no thanks", "I'll Give Later"];
const CLICK_DELAY_MS = 100;
const ARCHIVE_BASE = "./archives";

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/*                           SQLITE QUEUE MANAGEMENT                           */
/* -------------------------------------------------------------------------- */

class PersistentQueue {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        source_chat_id INTEGER,
        source_topic_id INTEGER,
        topic_name TEXT,
        message_text TEXT,
        archived_thread_id INTEGER,
        post_title TEXT,
        status TEXT DEFAULT 'pending',
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        UNIQUE(url)
      )
    `);
    await this.db.exec("CREATE INDEX IF NOT EXISTS idx_status ON queue(status)");
    await this.db.exec("CREATE INDEX IF NOT EXISTS idx_added_at ON queue(added_at)");
    console.log(`✅ Queue DB ready at ${this.dbPath}`);
  }

  async addJob(url) {
    try {
      const res = await this.db.run(
        `INSERT OR IGNORE INTO queue (url,status) VALUES (?, 'pending')`,
        [url]
      );
      if (res.changes === 0) {
        console.log(`⏭️ Duplicate skipped: ${url}`);
        return false;
      }
      console.log(`📥 Added job: ${url}`);
      return true;
    } catch (err) {
      console.error(`❌ Failed to add job: ${err.message}`);
      return false;
    }
  }

  async getNextJob() {
    const row = await this.db.get(
      `SELECT * FROM queue WHERE status='pending' ORDER BY added_at ASC LIMIT 1`
    );
    if (!row) return null;
    await this.db.run(
      `UPDATE queue SET status='processing', started_at=CURRENT_TIMESTAMP WHERE id=?`,
      [row.id]
    );
    return row;
  }

  async updateJobStatus(id, status, error = null) {
    const sql =
      status === "completed"
        ? `UPDATE queue SET status=?, completed_at=CURRENT_TIMESTAMP, error_message=? WHERE id=?`
        : `UPDATE queue SET status=?, error_message=? WHERE id=?`;
    await this.db.run(sql, [status, error, id]);
  }

  async getStats() {
    const rows = await this.db.all(
      `SELECT status, COUNT(*) as count FROM queue GROUP BY status`
    );
    const stats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const r of rows) stats[r.status] = r.count;
    const total = await this.db.get(`SELECT COUNT(*) as total FROM queue`);
    stats.total = total.total;
    return stats;
  }
}

/* -------------------------------------------------------------------------- */
/*                    FIND, CLICK, SCROLL, ARCHIVE (your logic)               */
/* -------------------------------------------------------------------------- */

function isClickable(el) {
  const tag = el.tagName.toLowerCase();
  const clickableTags = ["button", "a", "input"];
  if (clickableTags.includes(tag)) return true;
  if (el.hasAttribute("onclick")) return true;
  if (el.getAttribute("role") === "button") return true;
  if (el.tabIndex >= 0) return true;
  return false;
}

async function findMatchingClickableElements(frame, searchTerms) {
  return frame.$$eval(
    "*",
    (elements, searchTerms) => {
      const results = [];
      const terms = searchTerms.map((t) => t.toLowerCase());
      const isClickable = (el) => {
        const tag = el.tagName.toLowerCase();
        const clickableTags = ["button", "a", "input"];
        if (clickableTags.includes(tag)) return true;
        if (el.hasAttribute("onclick")) return true;
        if (el.getAttribute("role") === "button") return true;
        if (el.tabIndex >= 0) return true;
        return false;
      };
      for (const el of elements) {
        if (!isClickable(el)) continue;
        const text = (el.textContent || el.value || "").trim();
        if (!text) continue;
        const match = terms.some((t) => text.toLowerCase().includes(t));
        if (!match) continue;
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          x: rect.left + rect.width / 2 + window.scrollX,
          y: rect.top + rect.height / 2 + window.scrollY,
        });
      }
      return results;
    },
    searchTerms
  );
}

async function findAllMatchingElements(page, searchTerms) {
  const matches = [];
  for (const frame of page.frames()) {
    try {
      const found = await findMatchingClickableElements(frame, searchTerms);
      matches.push(...found);
    } catch {}
  }
  return matches;
}

async function simulateMouseClick(page, x, y) {
  const mouse = page.mouse;
  await mouse.move(x, y, { steps: 5 });
  await mouse.down();
  await sleep(40);
  await mouse.up();
  await sleep(CLICK_DELAY_MS);
}

async function clickElements(page, elements) {
  for (const el of elements) {
    try {
      console.log(`🖱️ Clicking <${el.tag}> "${el.text}"`);
      await simulateMouseClick(page, el.x, el.y);
    } catch (err) {
      console.warn(`⚠️ Failed to click "${el.text}": ${err.message}`);
    }
  }
}




async function clickPopups(page) {
  console.log("🔍 Checking for popups...");

  const matches = await findAllMatchingElements(page, SEARCH_TERMS);
  if (matches.length === 0) {
    console.log("ℹ️ No clickable popups found.");
    return;
  }

  console.log(`🧹 Found ${matches.length} clickable element(s):`);
  for (const el of matches) {
    const matched = SEARCH_TERMS.filter(t =>
      el.text.toLowerCase().includes(t.toLowerCase())
    );
    console.log(`   → <${el.tag}> "${el.text}" [${matched.join(", ")}]`);
  }

  await clickElements(page, matches);
  await sleep(1000);
  console.log("✅ Popup click pass done.\n");
}


async function triggerLazyLoadScroll(page) {
  await page.evaluate(async () => {
    const totalHeight = document.body.scrollHeight;
    const viewport = window.innerHeight;
    for (let y = 0; y < totalHeight; y += viewport / 2) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 300));
    }
    window.scrollTo(0, 0);
  });
  await sleep(1000);
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return rawUrl.trim();
  }
}

function slugifyTitle(title) {
  if (!title) return "untitled";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return u.hostname;
    const skip = new Set(["news", "article", "post", "view", "en"]);
    const filtered = parts.filter((p) => !skip.has(p.toLowerCase()));
    const joined = filtered.join("-") || u.hostname;
    return joined.replace(/[^\w\s-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  } catch {
    return "untitled";
  }
}

function md5Hash(input, length = 8) {
  return crypto.createHash("md5").update(input).digest("hex").slice(0, length);
}

function makeArchiveId(url, title) {
  const normalized = normalizeUrl(url);
  const urlHash = md5Hash(normalized, 8);
  const slug = slugifyTitle(title);
  return `${slug}_${urlHash}`;
}

async function saveArchive(page, url) {
  const title = slugFromUrl(url);
  const archiveId = makeArchiveId(url, title);
  const outdir = path.join(ARCHIVE_BASE, archiveId);
  fs.mkdirSync(outdir, { recursive: true });
  console.log(`\n🗄️  Starting archive save in: ${outdir}`);
  
  
  await clickPopups(page);
  const htmlPath = path.join(outdir, "page.html");
  const html = await page.content();
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log(`✅ Saved HTML: ${htmlPath}`);

  await triggerLazyLoadScroll(page);
  await clickPopups(page);
  const screenshotPath = path.join(outdir, "screenshot.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✅ Saved Screenshot: ${screenshotPath}`);

  //try {
    //await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
  //} catch {}
  //await sleep(400);

  await triggerLazyLoadScroll(page);
  await clickPopups(page);
  const pdfPath = path.join(outdir, "page.pdf");
  await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
  console.log(`✅ Saved PDF: ${pdfPath}`);

  const metrics = await page.evaluate(() => ({
    title: document.title,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  const meta = {
    url,
    timestamp: new Date().toISOString(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    metrics,
    archive_id: archiveId,
  };
  fs.writeFileSync(path.join(outdir, "meta.json"), JSON.stringify(meta, null, 2));
  console.log("🧾 Saved meta.json");
}

/* -------------------------------------------------------------------------- */
/*                              MAIN EXECUTION FLOW                            */
/* -------------------------------------------------------------------------- */

async function runArchive(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    console.log(`🌐 Visiting: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });
    
    //Experiment
    await sleep(2000);


    //const matches = await findAllMatchingElements(page, SEARCH_TERMS);
    //if (matches.length > 0) {
      //await clickElements(page, matches);
      //await sleep(2000);
    //}

    await clickPopups(page);

    await saveArchive(page, url);
    console.log("✅ Archive done.");
    return true;
  } catch (err) {
    console.error("❌ Archive failed:", err);
    return false;
  } finally {
    await browser.close();
  }
}

async function processQueue(queue) {
  console.log("🚀 Starting queue worker...");
  while (true) {
    const job = await queue.getNextJob();
    if (!job) {
      console.log("📭 No more pending jobs. Worker exiting.");
      break;
    }
    console.log(`📦 Processing job #${job.id}: ${job.url}`);
    const ok = await runArchive(job.url);
    await queue.updateJobStatus(job.id, ok ? "completed" : "failed", ok ? null : "Archive failed");
    const stats = await queue.getStats();
    console.log(`📊 Stats: ${JSON.stringify(stats)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dbFlagIndex = args.indexOf("--db");
  const dbPath = dbFlagIndex !== -1 ? args[dbFlagIndex + 1] : null;
  const url = args.find((a) => a.startsWith("http"));

  if (dbPath && !url) {
    const queue = new PersistentQueue(dbPath);
    await queue.init();
    await processQueue(queue);
    return;
  }

  if (url && !dbPath) {
    await runArchive(url);
    return;
  }

  console.error("Usage:\n  node integrated.js <URL>\n  node integrated.js --db ./queue.db");
  process.exit(1);
}

main();

