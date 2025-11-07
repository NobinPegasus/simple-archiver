#!/usr/bin/env node
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */
const SEARCH_TERMS = ["cancel", "close", "dismiss", "reject", "decline", "no thanks"];
const CLICK_DELAY_MS = 100;
const ARCHIVE_BASE = "./archives";

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                  */
/* -------------------------------------------------------------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Convert file size to human-readable string */
function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Determine if an element is clickable */
function isClickable(el) {
  const tag = el.tagName.toLowerCase();
  const clickableTags = ["button", "a", "input"];
  if (clickableTags.includes(tag)) return true;
  if (el.hasAttribute("onclick")) return true;
  if (el.getAttribute("role") === "button") return true;
  if (el.tabIndex >= 0) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*                        MATCH + FIND CLICKABLE ELEMENTS                      */
/* -------------------------------------------------------------------------- */

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
    } catch {
      // ignore cross-origin
    }
  }
  return matches;
}

/* -------------------------------------------------------------------------- */
/*                              CLICKING LOGIC                                */
/* -------------------------------------------------------------------------- */

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
      console.log(
        `🖱️ Clicking <${el.tag}> "${el.text}" at (${el.x.toFixed(0)}, ${el.y.toFixed(0)})`
      );
      await simulateMouseClick(page, el.x, el.y);
    } catch (err) {
      console.warn(`⚠️ Failed to click "${el.text}": ${err.message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                     Scrolling and Lazy Loading Logic                       */
/* -------------------------------------------------------------------------- */

/**
 * Smoothly scroll through the page to trigger lazy-loaders (IntersectionObservers, etc.)
 * This is a standard pre-capture scroll routine used by archive tools.
 */
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
  await sleep(1000); // allow late images to render
}

/* -------------------------------------------------------------------------- */
/*                               URL NORMALIZATION                            */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a URL by trimming whitespace, removing query params and fragments.
 * This ensures stable hashing and consistent deduplication.
 */
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

/* -------------------------------------------------------------------------- */
/*                                SLUG GENERATION                             */
/* -------------------------------------------------------------------------- */

/**
 * Produce a human-readable slug from a URL path.
 * Removes generic path tokens (like 'news', 'article', etc.)
 * and ensures filesystem-safe formatting.
 */
function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);

    if (!parts.length) return u.hostname;

    const skip = new Set(["news", "article", "post", "view", "en"]);
    const filtered = parts.filter((p) => !skip.has(p.toLowerCase()));
    const joined = filtered.join("-") || u.hostname;

    return joined
      .replace(/[^\w\s-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  } catch {
    return "untitled";
  }
}

/** Produce a clean slug from an arbitrary title. */
function slugifyTitle(title) {
  if (!title) return "untitled";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* -------------------------------------------------------------------------- */
/*                               HASH GENERATION                              */
/* -------------------------------------------------------------------------- */

/** Return a short deterministic MD5 hash for a given string. */
function md5Hash(input, length = 8) {
  return crypto.createHash("md5").update(input).digest("hex").slice(0, length);
}

/* -------------------------------------------------------------------------- */
/*                              ARCHIVE ID BUILDER                            */
/* -------------------------------------------------------------------------- */

/**
 * Create the final archive identifier used for folder naming.
 * Combines a URL-derived slug and a short hash of the normalized URL.
 * Example: "india-election-2025_a1b2c3d4"
 */
function makeArchiveId(url, title) {
  const normalized = normalizeUrl(url);
  const urlHash = md5Hash(normalized, 8);
  const slug = slugifyTitle(title);
  return `${slug}_${urlHash}`;
}

/* -------------------------------------------------------------------------- */
/*                                ARCHIVE LOGIC                               */
/* -------------------------------------------------------------------------- */

async function saveArchive(page, url) {
  // 🧩 Use unified archive ID (matches puppeteer_fallback.mjs)
  const title = slugFromUrl(url);
  const archiveId = makeArchiveId(url, title);
  const outdir = path.join(ARCHIVE_BASE, archiveId);
  fs.mkdirSync(outdir, { recursive: true });

  console.log(`\n🗄️  Starting archive save in: ${outdir}`);
  console.log(`📦 Archive ID: ${archiveId}`);

  // Save HTML
  const htmlPath = path.join(outdir, "page.html");
  const html = await page.content();
  fs.writeFileSync(htmlPath, html, "utf8");
  const htmlSize = humanFileSize(fs.statSync(htmlPath).size);
  console.log(`✅ Saved HTML (${htmlSize}): ${htmlPath}`);

  await triggerLazyLoadScroll(page);

  // Save Screenshot
  const screenshotPath = path.join(outdir, "screenshot.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const shotSize = humanFileSize(fs.statSync(screenshotPath).size);
  console.log(`✅ Saved Screenshot (${shotSize}): ${screenshotPath}`);

  // Wait for network idle before PDF
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
  } catch {}
  await sleep(400);

  await triggerLazyLoadScroll(page);

  // Save PDF
  const pdfPath = path.join(outdir, "page.pdf");
  await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
  const pdfSize = humanFileSize(fs.statSync(pdfPath).size);
  console.log(`✅ Saved PDF (${pdfSize}): ${pdfPath}`);

  // Meta info
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

  console.log(`🎯 Archive successfully completed → ${outdir}\n`);
}

/* -------------------------------------------------------------------------- */
/*                             DISPLAY UTILITIES                              */
/* -------------------------------------------------------------------------- */

function printElements(elements, terms) {
  console.log("\n" + "=".repeat(70));
  console.log(`Search Terms: ${terms.join(", ")}`);
  console.log(`Found ${elements.length} clickable element(s)`);
  console.log("=".repeat(70) + "\n");

  elements.forEach((el, i) => {
    console.log(`${i + 1}. <${el.tag}> "${el.text}"`);
  });
}

/* -------------------------------------------------------------------------- */
/*                                    MAIN                                    */
/* -------------------------------------------------------------------------- */

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node integrated.js <URL>");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: "new",
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

    console.log("🔍 Searching for clickable elements...");
    const matches = await findAllMatchingElements(page, SEARCH_TERMS);

    printElements(matches, SEARCH_TERMS);

    if (matches.length > 0) {
      console.log("\n⚡ Clicking matching elements...\n");
      await clickElements(page, matches);
      await sleep(2000); // wait for UI updates after clicks
    } else {
      console.log("\n❌ No matching clickable elements found.\n");
    }

    console.log("🗄️  Archiving page...");
    await saveArchive(page, url);

    console.log("✅ All archive tasks completed successfully.");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await browser.close();
  }
}

main();

