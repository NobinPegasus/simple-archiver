#!/usr/bin/env node
/**
 * puppeteer-archiver.mjs — minimal, sturdy boilerplate
 * Saves: raw HTML, full-page PNG, and a PDF for a given URL.
 *
 * Usage:
 *   node puppeteer-archiver.mjs "https://example.com/article"
 *
 * Output:
 *   ./archive/<YYYYMMDD-HHMMSS>_<slug>/
 *     - raw.html
 *     - screenshot.png
 *     - page.pdf
 *     - meta.json
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function slugFromUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    const s = (hostname + pathname)
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return s.slice(0, 80) || "page";
  } catch {
    return "page";
  }
}

// --- Optional hook for site-specific tweaks (left empty for now) ---
async function siteFixes(page, url) {
  // Example scaffold for later:
  // const host = new URL(url).hostname;
  // if (host.includes("timesofindia")) {
  //   await page.evaluate(() => {
  //     // Minimal TOI tweaks can go here later.
  //   });
  // }
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node puppeteer-archiver.mjs <url>");
    process.exit(1);
  }

  const outdir = path.join(process.cwd(), "archive", `${stamp()}_${slugFromUrl(url)}`);
  await fsp.mkdir(outdir, { recursive: true });
  console.log("📁 Output:", outdir);

  const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-zygote",
      "--disable-gpu",
      "--window-size=1440,900",
    ],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    page.setDefaultTimeout(60000);

    console.log("🌐 Navigating:", url);
    await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 0 });

    // Give the page a brief moment for any last layout thrash
    await sleep(800);

    // --- Hook: site-specific tweaks go here (currently no-op) ---
    await siteFixes(page, url);

    // Save raw HTML (serialized DOM)
    const html = await page.content();
    await fsp.writeFile(path.join(outdir, "raw.html"), html, "utf8");
    console.log("💾 Saved HTML");

    // Full-page screenshot
    await page.screenshot({ path: path.join(outdir, "screenshot.png"), fullPage: true });
    console.log("📸 Saved screenshot");

    // Switch to print media and save PDF
    await page.emulateMediaType("print");
    await page.pdf({
      path: path.join(outdir, "page.pdf"),
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0.4in", right: "0.4in", bottom: "0.4in", left: "0.4in" },
    });
    console.log("📕 Saved PDF");

    // Minimal metadata
    const metrics = await page.evaluate(() => ({
      title: document.title,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    await fsp.writeFile(
      path.join(outdir, "meta.json"),
      JSON.stringify(
        {
          url,
          timestamp: new Date().toISOString(),
          userAgent: UA,
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
          metrics,
        },
        null,
        2
      )
    );
    console.log("🧾 Saved meta.json");
  } catch (err) {
    console.error("❌ Archiving failed:\n", err?.stack || err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();

