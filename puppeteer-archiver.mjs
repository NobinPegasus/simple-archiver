#!/usr/bin/env node
/**
 * puppeteer-archiver.mjs — queue.db states: pending → processing → completed/failed
 * One-step-at-a-time worker: always finish an existing `processing` item first;
 * if none exists, atomically claim the next `pending` and process it.
 *
 * Usage:
 *   Single URL:
 *     node puppeteer-archiver.mjs "https://example.com/article"
 *
 *   From CSV:
 *     node puppeteer-archiver.mjs --file urls.csv [--limit 50]
 *
 *   From queue.db (states exactly: completed | failed | processing | pending):
 *     node puppeteer-archiver.mjs --db ./queue.db [--limit N] [--mode auto|processing|pending] [--no-claim] [--drain]
 *     # default: --mode auto, runs continuously until all items are completed/failed
 *     # --limit N = stop after processing N items (optional)
 *     # auto = prefer an existing `processing`; otherwise claim one `pending`.
 *     # processing = only handle rows already marked `processing` (never claim new).
 *     # pending = ignore processing; claim the next pending.
 *     # --no-claim = in auto mode, do NOT claim pending if no processing exists.
 *     # --drain = deprecated (now the default behavior)
 *
 * Output (all modes):
 *   ./archive/<YYYYMMDD-HHMMSS>_<slug>/
 *     - raw.html
 *     - screenshot.png
 *     - page.pdf
 *     - meta.json
 *
 * TIP: Install deps
 *   npm i puppeteer better-sqlite3
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

let Database = null;
try {
  const mod = await import("better-sqlite3");
  Database = mod.default || mod;
} catch (_) { /* optional until --db is used */ }

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

function parseArgs(argv) {
  const args = { _: [], limit: null, mode: "auto", noClaim: false, drain: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a.startsWith("--file=")) args.file = a.split("=")[1];
    else if (a === "--db") args.db = argv[++i];
    else if (a.startsWith("--db=")) args.db = a.split("=")[1];
    else if (a === "--limit") args.limit = parseInt(argv[++i] || "0", 10);
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.split("=")[1] || "0", 10);
    else if (a === "--mode") args.mode = (argv[++i] || "auto").toLowerCase();
    else if (a.startsWith("--mode=")) args.mode = a.split("=")[1].toLowerCase();
    else if (a === "--no-claim") args.noClaim = true;
    else if (a === "--drain") args.drain = true;
    else args._.push(a);
  }
  return args;
}

// --- Optional hook for site-specific tweaks ---
async function siteFixes(page, url) {
  // const host = new URL(url).hostname;
  // if (host.includes("timesofindia")) { /* tweaks here later */ }
}

async function archiveOne(browser, url) {
  const outdir = path.join(process.cwd(), "archive", `${stamp()}_${slugFromUrl(url)}`);
  await fsp.mkdir(outdir, { recursive: true });

  const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    page.setDefaultTimeout(60000);

    console.log("📦 Archiving:", url);
    console.log("📁 Output:", outdir);

    console.log("🌐 Navigating...");
    try {
      await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 0 });
    } catch (e) {
      console.warn("⚠️ goto warning:", e?.message);
    }

    await sleep(800); // settle
    await siteFixes(page, url);

    // HTML
    const html = await page.content();
    await fsp.writeFile(path.join(outdir, "raw.html"), html, "utf8");
    console.log("💾 Saved HTML");

    // Screenshot
    await page.screenshot({ path: path.join(outdir, "screenshot.png"), fullPage: true });
    console.log("📸 Saved screenshot");

    // PDF
    await page.emulateMediaType("print");
    await page.pdf({
      path: path.join(outdir, "page.pdf"),
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0.4in", right: "0.4in", bottom: "0.4in", left: "0.4in" },
    });
    console.log("📕 Saved PDF");

    // Meta
    const metrics = await page.evaluate(() => ({
      title: document.title,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    await fsp.writeFile(
      path.join(outdir, "meta.json"),
      JSON.stringify(
        { url, timestamp: new Date().toISOString(), userAgent: UA, viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, metrics },
        null,
        2
      )
    );
    console.log("🧾 Saved meta.json");

    await page.close();
    return { ok: true, outdir };
  } catch (err) {
    console.error("❌ Archiving failed:", err?.stack || err);
    try { await page.close(); } catch {}
    return { ok: false, error: String(err?.message || err) };
  }
}

// -------------- DB helpers (states: completed | failed | processing | pending) --------------
function getQueueColumns(db) {
  const rows = db.prepare("PRAGMA table_info(queue)").all();
  const names = new Set(rows.map((r) => r.name));
  return names; // e.g., id,url,status,outdir,tries,archived_at,last_error
}

function markProcessing(db, cols, id) {
  const sets = ["status='processing'"]; // exact state wording
  if (cols.has("tries")) sets.push("tries=COALESCE(tries,0)+1");
  if (cols.has("last_error")) sets.push("last_error=NULL");
  const sql = `UPDATE queue SET ${sets.join(", ")} WHERE id=?`;
  db.prepare(sql).run(id);
}

function markCompleted(db, cols, id, outdir) {
  const sets = ["status='completed'"]; // exact state wording
  if (cols.has("outdir")) sets.push("outdir=?");
  if (cols.has("archived_at")) sets.push("archived_at=datetime('now')");
  const sql = `UPDATE queue SET ${sets.join(", ")} WHERE id=?`;
  const params = cols.has("outdir") ? [outdir, id] : [id];
  db.prepare(sql).run(...params);
}

function markFailed(db, cols, id, error) {
  const sets = ["status='failed'"]; // exact state wording
  if (cols.has("last_error")) sets.push("last_error=?");
  if (cols.has("archived_at")) sets.push("archived_at=datetime('now')");
  const sql = `UPDATE queue SET ${sets.join(", ")} WHERE id=?`;
  const params = cols.has("last_error") ? [String(error).slice(0, 1000), id] : [id];
  db.prepare(sql).run(...params);
}

function pickProcessing(db) {
  return db.prepare("SELECT id, url FROM queue WHERE status='processing' ORDER BY id LIMIT 1").get();
}

function pickPending(db) {
  return db.prepare("SELECT id, url FROM queue WHERE status='pending' ORDER BY id LIMIT 1").get();
}

function claimPending(db, cols) {
  const tx = db.transaction(() => {
    const row = pickPending(db);
    if (!row) return null;
    markProcessing(db, cols, row.id);
    return row;
  });
  return tx();
}

// ------------------------------------ Main ------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  const hasUrl = args._[0];
  const hasCsv = !!args.file;
  const hasDb = !!args.db;

  if (!hasUrl && !hasCsv && !hasDb) {
    console.error(`Usage:
  node puppeteer-archiver.mjs <url>
  node puppeteer-archiver.mjs --file urls.csv [--limit N]
  node puppeteer-archiver.mjs --db ./queue.db [--limit N] [--mode auto|processing|pending] [--no-claim]`);
    process.exit(1);
  }

  await fsp.mkdir(path.join(process.cwd(), "archive"), { recursive: true });

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
    if (hasUrl) {
      const { ok, outdir, error } = await archiveOne(browser, hasUrl);
      if (ok) console.log("✅ Done:", outdir); else { console.error("❌ Failed:", error); process.exitCode = 1; }
      return;
    }

    if (hasCsv) {
      let i = 0;
      for await (const url of (async function* (filePath, limit) {
        const raw = await fsp.readFile(filePath, "utf8");
        const lines = raw.split(/\r?\n/);
        let count = 0;
        for (const line of lines) {
          if (limit && count >= limit) break;
          const t = line.trim();
          if (!t || t.startsWith("#")) continue;
          yield t; count++;
        }
      })(args.file, args.limit)) {
        i++;
        console.log(`
--- [${i}] ${url}`);
        const { ok, outdir, error } = await archiveOne(browser, url);
        if (ok) console.log("✅ Done:", outdir); else { console.error("❌ Failed:", error); }
      }
      return;
    }

    if (hasDb) {
      if (!Database) { console.error("❌ DB mode requires 'better-sqlite3' (npm i better-sqlite3)"); process.exit(1); }
      const db = new Database(args.db);
      const cols = getQueueColumns(db);

      let handled = 0;
      // Run continuously until no more work is available
      while (true) {
        let row = null;
        if (args.mode === "processing" || args.mode === "auto") {
          row = pickProcessing(db);
        }
        if (!row && args.mode !== "processing" && !args.noClaim) {
          row = claimPending(db, cols);
        }
        if (!row) {
          console.log("ℹ️ No work item available. All items processed!" );
          break;
        }

        console.log(`
--- [#${row.id}] ${row.url}`);
        const { ok, outdir, error } = await archiveOne(browser, row.url);
        if (ok) {
          markCompleted(db, cols, row.id, outdir);
          console.log("✅ Completed:", outdir);
        } else {
          markFailed(db, cols, row.id, error);
          console.error("❌ Failed:", error);
        }
        handled++;
        
        // Check if user specified a limit and we've reached it
        if (args.limit && handled >= args.limit) {
          console.log(`ℹ️ Reached limit of ${args.limit} items. Stopping.`);
          break;
        }
      }
      
      console.log(`\n🏁 Processing complete. Total items handled: ${handled}`);
      return;
    }
  } catch (err) {
    console.error("❌ Runner error:", err?.stack || err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();

