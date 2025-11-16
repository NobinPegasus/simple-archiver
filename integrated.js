#!/usr/bin/env node
// Stealth-enabled Puppeteer
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";


// Activate stealth before anything else
puppeteer.use(StealthPlugin());


// FIX: Split fs modules correctly
import fs from "fs/promises";      // async version
import fssync from "fs";           // sync version only

//import fs from "fs";
import path from "path";
import crypto from "crypto";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// --- SingleFile integration ---
import {
  script as SINGLEFILE_SCRIPT,
  hookScript as SINGLEFILE_HOOK,
  zipScript as SINGLEFILE_ZIP
} from "./single-file-cli/lib/single-file-bundle.js";


/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */
const SEARCH_TERMS =  ["close", "dismiss", "Don't Allow", "don't allow", "dont allow", "Later", "ok", "Reject",  "decline", "Decline Cookies", "no thanks", "I'll Give Later"];
const EXPAND_TERMS = ["Show Full Article",  "View Full Story", "Expand", "Continue Reading"];
const BLACKLIST_TERMS = ["Watch later", "facebook", "print ad", "bookmark", "sign in", "login"];
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
    (elements, searchTerms, blacklistTerms) => {
      const results = [];
      const terms = searchTerms.map(t => t.toLowerCase());

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

	// Skip long anchor links (article links, headlines)
	if (el.tagName.toLowerCase() === "a") {
	  const txt = (el.textContent || "").trim();
	  if (txt.length > 20) continue; // skip long anchors
	}



        const text = (el.textContent || el.value || "").trim();
        if (!text) continue;

	const normalize = s => s
	  .toLowerCase()
	  .replace(/[’‘']/g, "'") // unify smart quotes
	  .replace(/[^\w\s']/g, " ") // keep words & apostrophes
	  .trim();

	const txt = normalize(text);


        const matched = terms.some(term => {
          const t = term.toLowerCase().trim();

          // short terms like ok/no/yes: match exact word ignoring case
          if (t.length <= 3) {
            return txt.split(/\s+/).some(w => w.localeCompare(t, undefined, { sensitivity: "accent" }) === 0);
          }

          // longer terms: whole phrase regex, case-insensitive
          const pattern = new RegExp(`\\b${t.replace(/\s+/g, "\\s+")}\\b`, "i");
          return pattern.test(txt);
        });

        if (!matched) continue;

        // skip blacklisted text
        const lowerText = text.toLowerCase();
        const isBlacklisted = blacklistTerms.some(bad => lowerText.includes(bad.toLowerCase()));
        if (isBlacklisted) {
          console.log(`⏭️ Skipping blacklisted element: "${text}"`);
          continue;
        }

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
    searchTerms,
    BLACKLIST_TERMS // <── ✅ pass this into the browser context
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
      // Skip long anchors or obvious article links
      if (el.tag === "a") {
        const textLen = el.text.length;
        if (textLen > 15) {
          console.log(`⏭️ Skipping long <a> (${textLen} chars): "${el.text.slice(0, 40)}..."`);
          continue;
        }
      }

      console.log(`🖱️ Clicking <${el.tag}> "${el.text}" safely`);

      // 🧩 Inject a temporary global listener that blocks all navigations
      await page.evaluate(() => {
        window.__cancelNavigationPatch__ = true;
        window.addEventListener(
          "click",
          e => {
            // stop any anchor or button from changing location
            e.stopImmediatePropagation();
            e.preventDefault();
          },
          true
        );
        window.addEventListener(
          "beforeunload",
          e => {
            e.preventDefault();
            e.returnValue = "";
            return "";
          },
          true
        );
        window.onbeforeunload = null;
        window.onunload = null;
      });

      // Dispatch synthetic click manually in DOM
      await page.evaluate((text) => {
        const candidates = [...document.querySelectorAll("button, a, input, div[role='button']")];
        const target = candidates.find(b =>
          (b.innerText || b.value || "").trim().toLowerCase() === text.toLowerCase()
        );
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "instant" });
          ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(type => {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
          });
        }
      }, el.text);

      await sleep(500);

      // 🧹 Remove the global navigation blocker so normal links work again
      await page.evaluate(() => {
        if (window.__cancelNavigationPatch__) {
          window.removeEventListener("click", () => {}, true);
          delete window.__cancelNavigationPatch__;
        }
      });

    } catch (err) {
      console.warn(`⚠️ Failed to click "${el.text}": ${err.message}`);
    }
  }
}


/**
 * Dismiss or remove OneSignal notification prompt safely.
 * Clicks "Cancel" if possible, otherwise removes it and blocks reinjection.
 */
async function dismissOneSignalSlidedown(page) {
  console.log("🔕 Trying to dismiss OneSignal slidedown…");

  const result = await page.evaluate(async () => {
    const cancel = document.getElementById("onesignal-slidedown-cancel-button");
    const dialog = document.getElementById("onesignal-slidedown-dialog");
    if (!dialog) return "absent";

    // Make visible just in case
    if (cancel) {
      cancel.style.visibility = "visible";
      cancel.style.opacity = "1";
      cancel.style.pointerEvents = "auto";
    }

    // Helper to actually click it
    const doClick = (btn) => {
      ["pointerdown","mousedown","pointerup","mouseup","click"].forEach(t =>
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
      );
    };

    if (cancel) {
      try {
        cancel.scrollIntoView({ block: "center", behavior: "instant" });
        doClick(cancel);
      } catch {}
    }

    // Wait 1s for OneSignal internal handler to remove it
    await new Promise(r => setTimeout(r, 1000));
    const stillVisible = !!document.getElementById("onesignal-slidedown-dialog");
    if (!stillVisible) return "clicked";

    // 🧹 Force remove + future block
    dialog.remove();
    const style = document.createElement("style");
    style.id = "__onesignal_block__";
    style.textContent = `
      #onesignal-slidedown-dialog,
      .onesignal-slidedown-dialog,
      #onesignal-bell-container,
      .onesignal-bell-launcher { display:none!important; visibility:hidden!important; }
    `;
    document.head.appendChild(style);
    try { sessionStorage.setItem("onesignal-slidedown-dismissed", "1"); } catch {}
    return "removed";
  });

  if (result === "absent") console.log("ℹ️ No OneSignal dialog detected.");
  else if (result === "clicked") console.log("✅ OneSignal dialog dismissed by click.");
  else if (result === "removed") console.log("🧹 OneSignal dialog forcibly removed and blocked.");
  else console.log("⚠️ Unexpected OneSignal dismiss result:", result);
}





//ClickCloseButton
/**
 * Click any "close" button visible in DOM, shadow roots, or iframes.
 * Resilient against detached frames, slow ads, and missing bounding boxes.
 */
export async function clickVisualCloseButton(page) {
  console.log("🔍 Searching for visual close buttons...");

  // Short sleep helper
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function safeClick(page, handle, context = "main") {
    try {
      const element = handle.asElement ? handle.asElement() : handle;
      if (!element) throw new Error("Handle not an element");

      const box = await element.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const mouse = page.mouse;
        await mouse.move(x, y, { steps: 5 });
        await sleep(40);
        await mouse.down();
        await sleep(60);
        await mouse.up();
        console.log(`✅ ${context}: Mouse click at (${x.toFixed(1)}, ${y.toFixed(1)}).`);
        return true;
      }

      console.warn(`⚠️ ${context}: No bounding box, falling back to DOM click...`);
      await element.click({ delay: 50 });
      console.log(`✅ ${context}: ElementHandle.click() succeeded.`);
      return true;
    } catch (err) {
      // Last resort — dispatch a DOM click manually
      try {
        await handle.evaluate(el => {
          const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
          el.dispatchEvent(ev);
        });
        console.log(`✅ ${context}: Manual click dispatched.`);
        return true;
      } catch (inner) {
        console.warn(`⚠️ ${context} click failed: ${inner.message}`);
        return false;
      }
    }
  }

  // MAIN DOCUMENT
  const candidates = await page.$$('[id*="close"], [class*="close"], [aria-label*="close"]');
  for (const handle of candidates) {
    try {
      await handle.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" }));
      if (await safeClick(page, handle, "main")) return true;
    } catch {}
  }

  // SHADOW ROOTS
  try {
    const jsHandle = await page.evaluateHandle(() => {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (el.shadowRoot) {
          const btn = el.shadowRoot.querySelector('[id*="close"], [class*="close"], [aria-label*="close"]');
          if (btn) return btn;
        }
      }
      return null;
    });
    const shadowEl = jsHandle.asElement?.();
    if (shadowEl && (await safeClick(page, shadowEl, "shadow-root"))) return true;
  } catch (err) {
    console.warn(`⚠️ Shadow-root check failed: ${err.message}`);
  }

  // IFRAMES — each capped to 3s
  for (const frame of page.frames()) {
    if (!frame || frame === page.mainFrame() || frame.isDetached?.()) continue;

    try {
      const result = await Promise.race([
        (async () => {
          const handle = await frame.$('[id*="close"], [class*="close"], [aria-label*="close"]');
          if (handle) {
            console.log(`🎯 Found close button inside frame: ${frame.url()}`);
            await handle.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" }));
            return await safeClick(page, handle, "iframe");
          }
          return false;
        })(),
        sleep(3000).then(() => {
          throw new Error("frame timeout");
        })
      ]);
      if (result) return true;
    } catch (err) {
      if (!/cross-origin|detached/i.test(err.message))
        console.warn(`⚠️ Frame ${frame.url()} skipped: ${err.message}`);
    }
  }

  console.log("⚠️ No clickable close button found anywhere.");
  return false;
}

async function removeCookiePopup(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        '.cookies-popup',
        '#popup2',
        '.cookies-popup.open'
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) el.remove();
      }
    });
    console.log("🍪 Cookie popup removed (if present).");
  } catch (err) {
    console.log("Failed to remove cookie popup:", err);
  }
}


//ClickPopupsButton
async function clickPopups(page) {
  console.log("🔍 Checking for popups...");

  /* -----------------------------------------
   * 1️⃣ HIGH-PRIORITY DIRECT BUTTON MATCHING
   * ----------------------------------------- */
  const directSelectors = [
    "#rejectButton",
    ".ccp-btn.decline",
    "#closeButton",
    "button.close",
    "button[aria-label='Close']",
    "button.dismiss",
    "[data-action='reject']",
    "[data-action='decline']",
  ];

  const directClicked = await page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        return true;
      }
    }
    return false;
  }, directSelectors);

  if (directClicked) {
    console.log("🖱️ Direct cookie popup button clicked.");
    await sleep(800);
    return;
  }

  /* -----------------------------------------
   * 2️⃣ FALLBACK: SEMANTIC TEXT MATCHING
   * ----------------------------------------- */
  const matches = await findAllMatchingElements(page, SEARCH_TERMS);
  if (matches.length === 0) {
    console.log("ℹ️ No clickable popups found.");
    return;
  }

  // dedupe
  const unique = [];
  const seen = new Set();
  for (const el of matches) {
    const key = (el.text || "").trim().toLowerCase();
    if (!seen.has(key) && key) {
      seen.add(key);
      unique.push(el);
    }
  }

  console.log(`🧹 Found ${unique.length} unique clickable element(s):`);
  for (const el of unique) {
    const matched = SEARCH_TERMS.filter((t) =>
      el.text.toLowerCase().includes(t.toLowerCase())
    );
    console.log(`   → <${el.tag}> "${el.text}" [${matched.join(", ")}]`);
  }

  const first = unique[0];
  if (!first) {
    console.log("ℹ️ No valid popup button to click.");
    return;
  }

  console.log(`🖱️ Clicking popup: "${first.text}"`);
  await clickElements(page, [first]);
  await sleep(800);

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


/**
 * Remove floating "Back to Top" buttons or related UI widgets.
 * These are purely navigational and irrelevant for archival.
 */
async function removeBackToTopButton(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        '.back-to-top',
        '[class*="backtotop"]',
        '[id*="backtotop"]',
        '.js-back-to-top',
        '.js-bkt-out'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }
    });
    console.log('🧹 Removed back-to-top button successfully.');
  } catch (err) {
    console.warn('⚠️ Failed to remove back-to-top button:', err.message);
  }
}


/**
 * Remove or hide intrusive third-party widgets (e.g. JioSaavn)
 * Used right before screenshot or PDF capture to keep archives clean.
 */
async function removeJioSaavnWidget(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        '#jiosaavn-widget',
        '[id*="jiosaavn"]',
        'iframe[src*="jiosaavn.com"]'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          el.remove(); // physically remove from DOM
        });
      }
    });
    console.log('🧹 Removed JioSaavn widget successfully.');
  } catch (err) {
    console.warn('⚠️ Failed to remove JioSaavn widget:', err.message);
  }
}


/**
 * removeAdWrappers(page)
 * ----------------------------------------------------------
 * Removes common advertisement wrapper containers from the page DOM.
 * Specifically targets elements with classes like 'ads-wrp' or similar.
 * 
 * Usage:
 *    await removeAdWrappers(page);
 */
async function removeAdWrappers(page) {
  try {
    const removedCount = await page.evaluate(() => {
      const selectors = [
        'div.ads-wrp',           // direct ad wrappers
        'div[class*="ads-wrp"]', // partial matches
        'div[id*="ad-"]',        // generic ad IDs
        'div[class*="adbox"]',   // embedded ad boxes
        'div[class*="sponsor"]', // sponsored content blocks
        'div.LsWg_wr.LsWg_wr-pd'
      ];

      const matches = document.querySelectorAll(selectors.join(','));
      matches.forEach(el => el.remove());
      return matches.length; // return count to Node
    });

    console.log(`🧹 Removed[Ad] ${removedCount} advertisement container(s).`);
  } catch (err) {
    console.warn('⚠️ Failed to remove advertisement wrappers:', err.message);
  }
}





/**
 * Clicks "Read More" / "Show Full Article" / etc.
 * Prioritizes News18 <div id="readmore_story"> wrapper (actual clickable element).
 */
async function clickExpandableContent(page) {
  const EXPAND_TERMS = [
    "show full",
    "show full article",
    "show full story",
    "view full story",
    "load more",
    "continue reading",
    "show more",
    "expand",
    "see more",
    "read full article",
    "read full",
    "read",
  ];

  console.log("🔍 Searching for expandable content triggers...");

  const clicked = await page.evaluate(async (terms) => {
    const lower = (s) => (s || "").toLowerCase();

    const isVisible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        r.width > 4 &&
        r.height > 4 &&
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        cs.opacity !== "0"
      );
    };

    let btn = null;

    /* --------------------------------------------------------
     * 1️⃣ DIRECT SUPPORT — VdArt (Asianet)
     * -------------------------------------------------------- */
    btn =
      document.querySelector(".VdArt-Exp_btn__link") ||
      document.querySelector(".VdArt-Exp_btn__down") ||
      document.querySelector(".VdArt-Exp_btn__wrp a");
    if (btn && !isVisible(btn)) btn = null;

    /* --------------------------------------------------------
     * 2️⃣ Asianet "READ FULL ARTICLE" button
     * -------------------------------------------------------- */
    if (!btn) {
      btn = document.querySelector("button.btnreadfull");
      if (btn && !isVisible(btn)) btn = null;
    }

    /* --------------------------------------------------------
     * 3️⃣ Wrapper .readfullartidlebox
     * -------------------------------------------------------- */
    if (!btn) {
      const box = document.querySelector(".readfullartidlebox");
      if (box && isVisible(box)) {
        btn = box.querySelector("button, a, div[role='button']");
      }
      if (btn && !isVisible(btn)) btn = null;
    }

      /* --------------------------------------------------------
      * 4️⃣ Fallback: generic .VdArt wrapper
      * -------------------------------------------------------- */
      if (!btn) {
        btn = document.querySelector(".VdArt-Exp_btn__wrp");
        if (btn && !isVisible(btn)) btn = null;
      }

      /* --------------------------------------------------------
      * 4.5️⃣ NEW — Taboola/TimesNow/Other News Sites "Read Full Story"
      * -------------------------------------------------------- */
      if (!btn) {
        btn = document.querySelector("a.tbl-read-more-btn, a.tbl-read-more-trecs-btn");
        if (btn && !isVisible(btn)) btn = null;
      }

        /* --------------------------------------------------------
         * 5️⃣ MUI buttons ("Show Full Article")
         * -------------------------------------------------------- */
        if (!btn) {
          const candidates = Array.from(
            document.querySelectorAll(
              "button.MuiButton-root, button.MuiButtonBase-root, button"
            )
          );
    
          btn = candidates.find((el) => {
            if (!isVisible(el)) return false;
            const text = (el.innerText || "").toLowerCase().trim();
            return terms.some((term) => text.includes(term));
          });
        }
    
        /* --------------------------------------------------------
         * 6️⃣ FINAL fallback (role-based only)
         * -------------------------------------------------------- */
        if (!btn) {
          const sel = "button, a[role='button'], span[role='button'], div[role='button']";
          const all = Array.from(document.querySelectorAll(sel));
    
          btn = all.find((el) => {
            if (!isVisible(el)) return false;
            const text = (el.innerText || "").toLowerCase().trim();
            return terms.some((term) => text.includes(term));
          });
    }

    if (!btn) return false;

    btn.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 150));

    try {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) =>
        btn.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        )
      );
    } catch {
      btn.click();
    }

    return (btn.innerText || btn.textContent || "").trim() || btn.id || btn.className;
  }, EXPAND_TERMS);

  if (!clicked) {
    console.log("ℹ️ No expandable content triggers found.");
    return;
  }

  console.log(`🖱️ Programmatically clicked expandable trigger: "${clicked}"`);
  await sleep(800);

  // Verify expansion
  const expanded = await page.evaluate(() => {
    const art = document.querySelector("article, main, section") || document.body;
    const p = art.querySelectorAll("p");
    if (!window.__pCount) window.__pCount = p.length;
    return p.length > window.__pCount;
  });

  if (expanded) {
    console.log("✅ Content expanded successfully.");
  } else {
    console.log("⚠️ Expansion not detected. Continuing...");
  }
}


/**
 * Unified & enhanced "Read More" clicker.
 * Supports News18 patterns, generic buttons, and:
 *   <button id="expandbtn" class="expand-text-article-button">Read more</button>
 */
async function clickReadMore(page) {
  console.log("🔍 Looking specifically for a 'Read More' button...");

  const success = await page.evaluate(async () => {
    const isVisible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        r.width > 4 &&
        r.height > 4 &&
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        cs.opacity !== "0"
      );
    };

    let btn = null;

    /* ---------------------------------------------------------
     * 1️⃣ Explicit ABP Live selectors (your new element)
     * --------------------------------------------------------- */
    btn =
      document.querySelector("#read-full-article") ||
      document.querySelector(".article-more") ||
      document.querySelector(".abp-story-article-more");

    if (btn && !isVisible(btn)) btn = null;


    /* ---------------------------------------------------------
     * 2️⃣ Existing expandbtn pattern
     * --------------------------------------------------------- */
    if (!btn) {
      btn =
        document.querySelector("#expandbtn") ||
        document.querySelector(".expand-text-article-button");

      if (btn && !isVisible(btn)) btn = null;
    }

    /* ---------------------------------------------------------
     * 3️⃣ News18-specific selectors
     * --------------------------------------------------------- */
    if (!btn) {
      btn =
        document.querySelector("div[id^='readmore_story'] .news18_read_more") ||
        document.querySelector(".news18_read_more") ||
        document.querySelector("div[id^='readmore_story'], .rmbtn-box");

      if (btn && !isVisible(btn)) btn = null;
    }

    /* ---------------------------------------------------------
     * 4️⃣ Generic fallback matcher
     * --------------------------------------------------------- */
    if (!btn) {
      const candidates = Array.from(document.querySelectorAll("button, a, span, div"));
      btn = candidates.find((el) => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return text === "read more" || text.includes("read more");
      });

      if (btn && !isVisible(btn)) btn = null;
    }

    /* ---------------------------------------------------------
     * No button found
     * --------------------------------------------------------- */
    if (!btn) {
      console.log("❌ No 'Read More' found in DOM.");
      return false;
    }

    /* ---------------------------------------------------------
     * Click it
     * --------------------------------------------------------- */
    btn.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 200));

    try {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
        btn.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
          })
        );
      });
    } catch (e) {
      console.warn("Fallback: btn.click()", e);
      btn.click();
    }

    console.log("✅ Clicked Read More:", btn.outerHTML.slice(0, 160));
    return true;
  });

  if (success) {
    console.log("🖱️ 'Read More' click executed successfully.");
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    console.log("ℹ️ No 'Read More' button clicked.");
  }
}



/**
 * clickBottomFooterButton(page)
 * ---------------------------------------------------
 * Finds the bottom-footer sticky ad container and clicks
 * its toggle/close button. If the click fails or button
 * not found, hides the container so it doesn’t block layout.
 */
async function clickBottomFooterButton(page) {
  await page.evaluate(() => {
    // Selector for the sticky ad container and toggle button
    const adSelector = 'div._ap_apex_ad[style*="position: fixed"][data-section]';
    const adEl = document.querySelector(adSelector);
    if (!adEl) return;

    const sectionId = adEl.getAttribute('data-section');
    const toggleSelector = `span.stickyToggleButton-${sectionId}`;
    const toggleBtn = adEl.querySelector(toggleSelector);

    if (toggleBtn) {
      try {
        toggleBtn.scrollIntoView({ block: "center", behavior: "instant" });
        toggleBtn.click();
        return;
      } catch (err) {
        // proceed to fallback
      }
    }

    // Fallback: hide the ad container
    adEl.style.display = 'none';
    adEl.style.visibility = 'hidden';
    adEl.style.pointerEvents = 'none';
    adEl.style.height = '0px';
    adEl.style.margin = '0 !important';
    adEl.style.padding = '0 !important';
  });
}


async function injectHeaderHideCSS(page) {
  await page.evaluate(() => {
    try {
      let style = document.getElementById('__hide_headers_style');
      if (!style) {
        style = document.createElement('style');
        style.id = '__hide_headers_style';
        document.head.appendChild(style);
      }

      style.textContent = `
        /* ============================
           GLOBAL HEADER REMOVALS
        ============================ */
        header,
        nav,
        [class*="header"],
        [class*="top-bar"],
        [class*="menu-bar"],
        [class*="headMenu"],
        [class*="fixedNav"],
        [class*="leftFixedNav"],
        [class*="leftSecNav"],
        [class*="moreNav"],
        [id*="sticky"],
        [id*="header"],
        [id*="navbar"],
        [style*="position:fixed"],
        [style*="position: sticky"] {
          display: none !important;
          visibility: hidden !important;
          height: 0 !important;
          min-height: 0 !important;
          overflow: hidden !important;
          position: static !important;
        }

        /* ============================
           INDIA.COM HEADER BLOCKS
        ============================ */
        section.content > .logo-wrap,
        .logo-wrap,
        .logo-hamburger,
        .top-right-content,
        .primary-wrap,
        .secondary-wrap,
        .main-menu,
        .main-nav,
        .mega-menu,
        .mega-trigger-btn,
        .mega-nav-all,
        .google-follow,
        .search,
        .search-triger,
        #mainMenu,
        #mainMenu-secondary,
        #autoNav,
        #autoNav-secondary,
        #login_sec,
        #logged_info_sec,
        .language-switch {
          display: none !important;
          visibility: hidden !important;
          height: 0 !important;
          min-height: 0 !important;
          overflow: hidden !important;
          position: static !important;
        }

        /* remove inline clipped containers */
        [style*="overflow:hidden"],
        [style*="overflow: clip"] {
          overflow: visible !important;
        }

        /* ============================
           LAYOUT RESTORATION
        ============================ */
        html, body {
          height: auto !important;
          overflow: visible !important;
        }

        main, article, section {
          height: auto !important;
          overflow: visible !important;
          transform: none !important;
        }
      `;
    } catch (err) {
      console.warn("⚠️ Failed to inject header-hide styles:", err.message);
    }
  });
}


async function hideStickyFooters(page) {
  await page.evaluate(() => {
    // Remove the known bottom sticky navigation bars completely
    document.querySelectorAll('.m-mb, .m-bm, .bottom_sticky_nav').forEach(el => {
      if (
        el.classList.contains('m-mb') ||
        el.classList.contains('m-bm') ||
        el.classList.contains('bottom_sticky_nav')
      ) {
        el.remove();
      }
    });

    // ⭐ NEW — remove Scroll.in sticky-bottom carousel
    document.querySelectorAll(
      '.sticky-bottom-carousel, ' +
      '[class*="sticky-bottom-carousel"], ' +
      '.carousel-is-sticky'
    ).forEach(el => el.remove());


    // ⭐ NEW — Remove IndiaToday / AI Recommended footer widget
    document.querySelectorAll(
      '.recommended__widget, ' +
      '[class*="AiRecommended_recommended__widget"], ' + 
      '.AiRecommended_recommended__widget__ZkRo0, ' +
      '.AiRecommended_recommendedCarousel__close__UUtA0, ' +
      '[class*="recommendedCarousel__close"], ' +
      '[class*="AiRecommended_slideContainer"], ' +
      '[class*="AiRecommended_recommended__slide"], ' +
      '.carousel__recommended'
    ).forEach(el => el.remove());



    // =============================
    // Inject / Update hide CSS
    // =============================
    let style = document.getElementById('__hide_footer_style');
    if (!style) {
      style = document.createElement('style');
      style.id = '__hide_footer_style';
      document.head.appendChild(style);
    }

    style.textContent = `
      /* Original footer hiding logic */
      footer,
      [class*="ftr-stk"],
      [class*="footer"],
      [id*="footer"],
      [class*="FtrWdg"],

      /* Extended: hide mobile bottom nav and sticky bars */
      [class*="bottom-nav"],
      [class*="mobile-bottom-bar"],
      [class*="bottom-navbar"],
      [id*="bottomBar"],
      .bottom_sticky_nav,
      .m-mb,
      .m-bm,

      /* Hide Scroll.in sticky-bottom carousel */
      .sticky-bottom-carousel,
      [class*="sticky-bottom-carousel"],
      .carousel-is-sticky,

      /* NEW — Hide IndiaToday AI recommended footer sliders */
      .recommended__widget,
      [class*="AiRecommended_recommended__widget"],
      .AiRecommended_recommendedCarousel__close__UUtA0,
      [class*="recommendedCarousel__close"],
      [class*="AiRecommended_slideContainer"],
      [class*="AiRecommended_recommended__slide"],
      .carousel__recommended
      {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
      }

      /* Clean up body margins so content extends fully */
      html, body {
        margin-bottom: 0 !important;
        padding-bottom: 0 !important;
      }

      main, article, section {
        margin-bottom: 0 !important;
        padding-bottom: 0 !important;
      }
    `;
  });
}


async function removeAvpVideo(page) {
  // Try clicking the Video.js close button first
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector(
      '.vjs-close-button.vjs-control.vjs-button.ubp-close'
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (clicked) {
    console.log("🖱️ Clicked AVP close button.");
    // Give the UI a moment to collapse before removing leftovers
    await sleep(300);
  }

  // Existing cleanup logic
  const removed = await page.evaluate(() => {
    const selectors = [
      'avp-content',
      '[class*="avp-content"]',
      'video[src^="blob:"][playsinline]',
      'video[src^="blob:"]'
    ];

    let count = 0;

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.remove();
        count++;
      });
    });

    document.querySelectorAll('div').forEach(div => {
      if (div.innerHTML.includes('<avp-content')) {
        div.remove();
        count++;
      }
    });

    return count;
  });

  console.log(`🧹 Removed ${removed} AVP / blob video element(s).`);
}


async function restoreStickyFooters(page) {
  await page.evaluate(() => {
    const style = document.getElementById('__hide_footer_style');
    if (style) style.remove();
  });
}




// cleanup/ads.js
export async function removeAllGoogleAds(pageOrHtml) {
  const adRegexes = [
    // Sticky ADP and adpTags containers
    /<div[^>]*class=["'](?:adp_interactive_ad|_ap_apex_ad)[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi,
    // Sticky footer/top ad blocks
    /<div[^>]*id=["']STICKY_ADP_[^"']*["'][\s\S]*?<\/div>\s*/gi,
    // Google ad iframes and containers
    /<iframe[^>]*id=["']google_ads_iframe_[^"']*["'][\s\S]*?<\/iframe>\s*/gi,
    /<div[^>]*id=["']google_ads_iframe_[^"']*["'][\s\S]*?<\/div>\s*/gi,
    // GPT display script calls
    /<script[^>]*>\s*googletag\.cmd\.push\([\s\S]*?\);\s*<\/script>/gi,
    // Divs with Google ad query identifiers
    /<div[^>]*data-google-query-id=["'][^"']+["'][\s\S]*?<\/div>\s*/gi,
    // Generic ADP data attributes (adpTags, adp networks)
    /<div[^>]*(data-ap-network|data-section)=["'][^"']+["'][\s\S]*?<\/div>\s*/gi,
  ];

  // --- HTML string mode ---
  if (typeof pageOrHtml === "string") {
    let cleaned = pageOrHtml;
    for (const regex of adRegexes) {
      cleaned = cleaned.replace(regex, "<!-- 🧩 removed ad block -->");
    }
    return cleaned;
  }

  // --- Puppeteer page mode ---
  const page = pageOrHtml;
  await page.evaluate(() => {
    // Remove ADP/adpTags containers
    document.querySelectorAll('.adp_interactive_ad, ._ap_apex_ad, [data-ap-network], [data-section]').forEach(el => el.remove());
    // Remove sticky ad containers
    document.querySelectorAll('[id^="STICKY_ADP_"]').forEach(el => el.remove());
    // Remove Google ad iframes and wrappers
    document.querySelectorAll('iframe[id^="google_ads_iframe_"]').forEach(el => {
      const container = el.closest('div[id*="google_ads_iframe"]') || el.parentElement;
      if (container) container.remove();
      else el.remove();
    });
    // Remove query-marked Google ad divs
    document.querySelectorAll('[data-google-query-id]').forEach(el => el.remove());
    // Remove inline GPT ad scripts
    document.querySelectorAll('script').forEach(s => {
      if (/googletag\.cmd\.push/.test(s.textContent)) s.remove();
    });
  });
}



async function removeIzootoBranding(page) {
  try {
    const removedCount = await page.evaluate(() => {
      const selectors = [
        '.iz-branding',
        '.iz-text',
        '.iz-brand',
        '[class*="izooto"]',
        '[id*="izooto"]',
        '[data-izooto]',
        'a[href*="izooto.com"]',
        'iframe[src*="izooto.com"]',
      ];

      let removed = 0;

      // Remove directly matched elements
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          el.remove();
          removed++;
        });
      });

      // Remove any container that says “Powered by iZooto” or “Notifications Powered by”
      document.querySelectorAll('body div, body span, body section').forEach(el => {
        const text = (el.textContent || '').toLowerCase();
        if (text.includes('powered by') && text.includes('izooto')) {
          el.remove();
          removed++;
        }
      });

      return removed;
    });

    console.log(`🧹 Removed ${removedCount} iZooto branding element(s).`);
  } catch (err) {
    console.warn('⚠️ Failed to remove iZooto branding:', err.message);
  }
}


/**
 * removeFloatingExplainers(page)
 * ----------------------------------------------------------
 * Removes floating bottom "Explainer" promo boxes or
 * similar fixed-position story suggestion widgets.
 *
 * Usage:
 *    await removeFloatingExplainers(page);
 */
async function removeFloatingExplainers(page) {
  try {
    const removedCount = await page.evaluate(() => {
      const selectors = [
        // Generic fixed-position promos
        'div[class*="fixed"][class*="bottom"]',
        // Specific patterns observed in TheDailyJagran, etc.
        'div[class*="animate-slide-up"]',
        'div[aria-label*="popup" i]',
      ];

      let removed = 0;
      document.querySelectorAll(selectors.join(',')).forEach(el => {
        const text = (el.textContent || '').toLowerCase();
        const hasExplainer =
          text.includes('explainer');

        const hasFixed = getComputedStyle(el).position === 'fixed';
        const hasZIndex = parseInt(getComputedStyle(el).zIndex || '0', 10) >= 30;

        // Only remove likely overlays/promos
        if (hasExplainer || (hasFixed && hasZIndex)) {
          el.remove();
          removed++;
        }
      });

      return removed;
    });

    console.log(`🧹 Removed ${removedCount} floating Explainer/promo box(es).`);
  } catch (err) {
    console.warn('⚠️ Failed to remove floating explainers:', err.message);
  }
}



// cleanup/ads.js
export async function removeFooterAds(pageOrHtml) {
  if (typeof pageOrHtml === "string") {
    return pageOrHtml.replace(
      /<div[^>]*class=["']td-fix-index["'][\s\S]*?<\/div>\s*<\/div>/gi,
      "<!-- 🧩 removed ThePrint footer ad -->"
    );
  } else {
    await pageOrHtml.evaluate(() => {
      document.querySelectorAll('.td-fix-index').forEach(el => el.remove());
    });
  }
}



/**
 * Robust: clicks the 'Load More' <a> inside updateBtn 4 times,
 * scrolling between clicks and waiting for new items.
 */
async function clickLoadMoreAndScroll(page) {
  console.log("🔁 Clicking 'Load More' up to 4 times with scroll...");

  for (let i = 1; i <= 4; i++) {
    const found = await page.evaluate(() => {
      // Try News18 / styled-JSX pattern first
      let btn =
        document.querySelector("div.updateBtn a.vwmore") ||
        document.querySelector("a.vwmore") ||
        document.querySelector("div.updateBtn");

      if (!btn) {
        // Generic fallback
        btn = Array.from(
          document.querySelectorAll("a, button, div, span, [role='button']")
        ).find(el =>
          /load\s*more/i.test(el.innerText || el.textContent || "")
        );
      }

      if (!btn) return null;

      const rect = btn.getBoundingClientRect();
      const style = getComputedStyle(btn);
      const visible =
        rect.width > 4 &&
        rect.height > 4 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
      if (!visible) return null;

      btn.scrollIntoView({ block: "center", behavior: "instant" });

      // Dispatch synthetic events for reliability
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(t =>
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
      );

      return btn.outerHTML.slice(0, 100);
    });

    if (!found) {
      console.log(`ℹ️ No visible "Load More" on iteration #${i}, stopping.`);
      break;
    }

    console.log(`🖱️ Clicked 'Load More' #${i}: ${found}`);
    await sleep(1500);

    // ✅ Scroll to trigger lazy loading after each click
    await page.evaluate(async () => {
      for (let y = 0; y < window.innerHeight * 0.8; y += 100) {
        window.scrollBy(0, 100);
        await new Promise(r => setTimeout(r, 40));
      }
    });

    await sleep(1500); // let new items render
  }

  console.log("✅ Completed 'Load More' + scroll sequence.\n");
}


async function captureWithSingleFile(page, outdir, filename = "singleFile.html") {
  const savePath = path.join(outdir, filename);
  
  const sfData = await page.evaluate(async (zipScript) => {
    return await window.singlefile.getPageData({
      compressContent: false,
      removeHiddenElements: false,
      removeUnusedStyles: false,
      removeUnusedFonts: false,
      removeAlternativeImages: false,
      removeAlternativeMedias: false,
      blockScripts: true,
      blockVideos: false,
      blockAudios: false,
      zipScript
    });
  }, SINGLEFILE_ZIP);

  if (!sfData || !sfData.content) {
    throw new Error("SingleFile returned empty content.");
  }

  const html =
    typeof sfData.content === "string"
      ? sfData.content
      : Buffer.from(sfData.content).toString("utf8");

  // FIXED: correct fs.promises.writeFile usage
  await fs.writeFile(savePath, html, { encoding: "utf8" });

  console.log(`💾 Saved SingleFile HTML: ${savePath}`);
  return savePath;
}


/**
 * Remove OneSignal floating bell launcher and block future reinjection.
 * Works even if injected dynamically after page load.
 */
async function removeOneSignalBell(page) {
  console.log("🔕 Removing OneSignal bell launcher...");

  const removed = await page.evaluate(() => {
    try {
      let count = 0;
      const selectors = [
        '#onesignal-bell-launcher',
        '.onesignal-bell-launcher',
        '#onesignal-bell-container',
        '[id*="onesignal-bell"]',
        '[class*="onesignal-bell"]'
      ];

      // Remove existing bell elements
      document.querySelectorAll(selectors.join(',')).forEach(el => {
        el.remove();
        count++;
      });

      // Inject persistent blocker to stop reinjection
      const styleId = '__onesignal_bell_block__';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          #onesignal-bell-launcher,
          .onesignal-bell-launcher,
          #onesignal-bell-container,
          [id*="onesignal-bell"],
          [class*="onesignal-bell"] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
          }
        `;
        document.head.appendChild(style);
      }

      // Mark in sessionStorage to discourage reinit
      try { sessionStorage.setItem("onesignal-bell-removed", "1"); } catch {}

      return count;
    } catch (err) {
      console.warn("⚠️ removeOneSignalBell error:", err.message);
      return 0;
    }
  });

  if (removed > 0) {
    console.log(`🧹 Removed ${removed} OneSignal bell element(s) and blocked reinjection.`);
  } else {
    console.log("ℹ️ No OneSignal bell found (maybe already removed or blocked).");
  }
}


async function saveArchive(page, url) {
  const title = slugFromUrl(url);
  const archiveId = makeArchiveId(url, title);
  const outdir = path.join(ARCHIVE_BASE, archiveId);
  fssync.mkdirSync(outdir, { recursive: true });
  console.log(`\n🗄️  Starting archive save in: ${outdir}`);

  // ✅ Capture pristine DOM early before modification
  const rawHtml = await page.content();
  const realPath = path.join(outdir, "page_raw.html");
  fssync.writeFileSync(realPath, rawHtml, "utf8");
  console.log(`💾 Saved original HTML snapshot: ${realPath}`);
	
  // Now modify the live page
  // await dismissOneSignalSlidedown(page);
  // await removeOneSignalBell(page);
  // await clickPopups(page);

  // --- inject a literal <script> into the saved HTML so archived file contains it ---
  // const injectionId = "__injected_nav_blocker_fe__";
  // const injectionScript = `<script id="${injectionId}">
  //   try {
  //     if (window.navigation) {
  //       try {
  //         window.navigation.onnavigate = e => {
  //           if (e.sourceElement) return;
  //           e.preventDefault();
  //         };
  //       } catch (err) {
  //         try {
  //           window.navigation.addEventListener?.('navigate', ev => {
  //             if (ev.sourceElement) return;
  //             ev.preventDefault();
  //           });
  //         } catch (__) {}
  //       }
  //     }
  //   } catch (ignore) {}
  // </script>`;

  // await triggerLazyLoadScroll(page);

  // ✅ Capture modified DOM now
  let modifiedHtml = await page.content();

  // // Inject navigation-blocker script safely
  // if (!/id=["']__injected_nav_blocker_fe__["']/.test(modifiedHtml)) {
  //   if (/<head[^>]*>/i.test(modifiedHtml)) {
  //     modifiedHtml = modifiedHtml.replace(/<head[^>]*>/i, m => `${m}\n${injectionScript}`);
  //   } else if (/<html[^>]*>/i.test(modifiedHtml)) {
  //     modifiedHtml = modifiedHtml.replace(/<html[^>]*>/i, m => `${m}\n<head>\n${injectionScript}\n</head>\n`);
  //   } else {
  //     modifiedHtml = `${injectionScript}\n${modifiedHtml}`;
  //   }
  // }
  // await hideStickyFooters(page);

  // await clickBottomFooterButton(page);
  //await removeFooterAds(page);


  // await removeAllGoogleAds(page);

  const htmlPath = path.join(outdir, "page.html");
  fssync.writeFileSync(htmlPath, modifiedHtml, "utf8");
  console.log(`✅ Saved sanitized HTML: ${htmlPath}`);

  // await triggerLazyLoadScroll(page);
  //await clickPopups(page);
  //await clickVisualCloseButton(page);
  // await directClickAnyCloseButton(page);
  //await page.setBypassCSP(true);
  //await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {});

  // await clickExpandableContent(page); 
  
  //await hideStickyFooters(page);
  // await sleep(300);


// 🧩 Fix ThePrint white PDF/screenshot issue
// await page.evaluate(() => {
//   document.querySelectorAll('html, body, main, article, section, div').forEach(el => {
//     const s = getComputedStyle(el);
//     if (s.transform && s.transform !== 'none') el.style.transform = 'none';
//     if (s.overflow.includes('hidden')) el.style.overflow = 'visible';
//     if (s.height && s.height !== 'auto') el.style.height = 'auto';
//     if (s.maxHeight && s.maxHeight !== 'none') el.style.maxHeight = 'none';
//   });
//   document.body.style.background = '#fff';
//   document.documentElement.style.background = '#fff';
//   window.scrollTo(0, 0);
// });

// await removeAvpVideo(page);
// await clickPopups(page);


// 🧭 ensure scroll, animations, and network quiet before screenshot
// await page.evaluate(() => new Promise(resolve => {
//   window.scrollTo(0, 0);
//   requestAnimationFrame(() => {
//     setTimeout(resolve, 1200); // small buffer for sticky/animation settle
//   });
// }));

// await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {});
//await clickBottomFooterButton(page); 
  //await removeFooterAds(page);

  // await injectHeaderHideCSS(page);

  // await sleep(1000);

  // await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {});
  
	const screenshotPath = path.join(outdir, "screenshot.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✅ Saved Screenshot: ${screenshotPath}`);

  //try {
    //await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
  //} catch {}
  //await sleep(400);

  // await triggerLazyLoadScroll(page);
  // await clickPopups(page);
  //await clickVisualCloseButton(page);
  //await directClickAnyCloseButton(page);
  //await removeBackToTopButton(page);
  //await removeAdWrappers(page);
  await sleep(300);

  const pdfPath = path.join(outdir, "page.pdf");

	// Wait for layout to stabilize before PDF
	// await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
  // await removeAvpVideo(page);

  // hide headers before PDF and before SingleFile capture
  // await injectHeaderHideCSS(page);

	//await hideStickyFooters(page);
	//await removeIzootoBranding(page);
	//await removeFloatingExplainers(page);


	// ✅ Minimal anti-clip patch for screen PDFs
	// await page.evaluate(() => {
	//   document.querySelectorAll('*').forEach(e => {
	//     const s = getComputedStyle(e);
	//     if (s.overflow.includes('hidden')) e.style.overflow = 'visible';
	//     if (['fixed','sticky'].includes(s.position)) e.style.position = 'static';
	//   });
	//   document.body.style.overflow = document.documentElement.style.overflow = 'visible';
	// });
	// await sleep(1000); // small repaint buffer


// Fix ThePrint white rendering (GPU layer + overflow issue)
// await page.evaluate(() => {
//   document.querySelectorAll('html, body, main, article, section, div').forEach(el => {
//     const s = getComputedStyle(el);
//     if (s.transform && s.transform !== 'none') el.style.transform = 'none';
//     if (s.overflow.includes('hidden')) el.style.overflow = 'visible';
//     if (s.height && s.height !== 'auto') el.style.height = 'auto';
//     if (s.maxHeight && s.maxHeight !== 'none') el.style.maxHeight = 'none';
//   });
//   document.body.style.background = '#fff';
//   document.documentElement.style.background = '#fff';
// });

  // await injectHeaderHideCSS(page);

	// await sleep(3000);

	await page.setViewport({ width: 1440, height: 900 });
	await page.emulateMediaType('screen');
	await page.pdf({
	  path: pdfPath,
	  format: 'A4',
	  margin: {bottom: "8px", left: "8px"},
	  printBackground: true,
	  scale: 0.98
	});


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
  fssync.writeFileSync(path.join(outdir, "meta.json"), JSON.stringify(meta, null, 2));
  console.log("🧾 Saved meta.json");

//   console.log("🔄 Preparing clean environment for SingleFile…");

//   // 🔥 Remove earlier click-blockers, unload blockers, sticky patches
//   await page.evaluate(() => {
//     try {
//       window.onbeforeunload = null;
//       window.onunload = null;
//       window.__cancelNavigationPatch__ = false;
//       document.querySelectorAll('style#__hide_footer_style').forEach(s => s.remove());
//       document.querySelectorAll('style#__onesignal_bell_block__').forEach(s => s.remove());
//     } catch {}
//   });

//   // 🔥 RE-INJECT SingleFile BEFORE reload
//   await page.evaluateOnNewDocument(() => {}); // flush previous scripts
//   await page.evaluateOnNewDocument(SINGLEFILE_HOOK);
//   await page.evaluateOnNewDocument(`
//     ${SINGLEFILE_SCRIPT}
//     window.singlefile = singlefile;
//   `);

// console.log("🔄 Reloading clean page (sandbox reset)…");

// await page.evaluate(() => {
//   try {
//     // 1. Remove direct handlers
//     window.onbeforeunload = null;

//     // 2. Override the property
//     Object.defineProperty(window, "onbeforeunload", {
//       get() { return null; },
//       set() {},  // ignore
//     });

//     // 3. Block addEventListener("beforeunload")
//     const origAdd = EventTarget.prototype.addEventListener;
//     EventTarget.prototype.addEventListener = function(type, listener, opts) {
//       if (type === "beforeunload") return;
//       return origAdd.call(this, type, listener, opts);
//     };

//     // 4. Block returnValue assignments
//     Object.defineProperty(Event.prototype, "returnValue", {
//       get() { return undefined; },
//       set() {} // ignore
//     });
//   } catch {}
// });


// // Step 1: Completely reset the world by loading a blank document
// await page.goto("about:blank", { waitUntil: "domcontentloaded" });

// // Step 2: Re-inject SingleFile engine on clean context
// await page.evaluateOnNewDocument(SINGLEFILE_HOOK);
// await page.evaluateOnNewDocument(`
//   ${SINGLEFILE_SCRIPT}
//   window.singlefile = singlefile;
// `);

// // Step 3: Navigate to target URL WITHOUT heavy JS execution
// await page.setJavaScriptEnabled(true);
// await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
// //await page.setJavaScriptEnabled(true);

// page.on("dialog", async dialog => {
//   // Handle native browser beforeunload confirmation
//   if (dialog.type() === "beforeunload") {
//     console.log("⚠️ Auto-accepting beforeunload dialog (Leave site)");
//     await dialog.accept();     // this is clicking "Leave"
//   } else {
//     await dialog.dismiss();
//   }
// });

// // Step 4: Let JS run now that SingleFile engine is ready
// await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));

// // Step 5: Load lazy elements
// // await triggerLazyLoadScroll(page);


// // await clickReadMore(page);
// // await removeCookiePopup(page);

// // await clickExpandableContent(page);
// // await removeAvpVideo(page);
// // await clickExpandableContent(page);

// // await removeCookiePopup(page);
// // await clickPopups(page);
// // await clickReadMore(page);
// await sleep(200);
// // Step 6: Capture


// // Force layout stabilization
// await page.evaluate(() => {
//   document.body.offsetHeight; // trigger reflow
//   window.scrollTo(0, 0);
// });
// await sleep(300);

// console.log("📦 Running final SingleFile capture…");

// await captureWithSingleFile(page, outdir, "singleFile.html");

// console.log("🔄 Preparing clean environment for SingleFile (isolated tab)…");

// // Create a fresh page just for SingleFile
// const sfPage = await page.browser().newPage();

// // (Optional) copy user agent to match the main page
// try {
//   const ua = await page.userAgent();
//   await sfPage.setUserAgent(ua);
// } catch {}

// // (Optional but recommended) copy cookies so auth/session is preserved
// try {
//   const cookies = await page.cookies();
//   if (cookies.length) {
//     await sfPage.setCookie(...cookies);
//   }
// } catch {}

// console.log("🔄 Preloading SingleFile hooks in new tab…");
// await sfPage.evaluateOnNewDocument(SINGLEFILE_HOOK);
// await sfPage.evaluateOnNewDocument(`
//   ${SINGLEFILE_SCRIPT}
//   window.singlefile = singlefile;
//   // expose for convenience if needed
//   window.singlefileInstance = singlefile;
// `);

// console.log("🔄 Loading target URL in SingleFile tab…");
// await sfPage.setJavaScriptEnabled(true);

// // For this pass, domcontentloaded is usually enough and safer
// await sfPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

// // Let site JS settle a bit (hydration, lazy stuff)
// await sfPage.evaluate(() => new Promise(r => setTimeout(r, 1500)));
// await sleep(200);

// // Optional: small layout stabilization
// await sfPage.evaluate(() => {
//   document.body && document.body.offsetHeight;
//   window.scrollTo(0, 0);
// });
// await sleep(300);

// await clickExpandableContent(sfPage);
// await triggerLazyLoadScroll(sfPage);


// await page.evaluate(async () => {
//   const embeds = document.querySelectorAll(
//     'iframe[src*="indiatoday.in/share/video"], iframe[src*="/embed/"], iframe[src*="youtube.com"], iframe[src*="twitter.com"]'
//   );
//   for (const iframe of embeds) {
//     try {
//       // Force real src (remove lazy attributes)
//       if (iframe.hasAttribute('data-src') && !iframe.src) {
//         iframe.src = iframe.getAttribute('data-src');
//       }
//       iframe.removeAttribute('loading');
//       iframe.style.minHeight = '300px';
//       iframe.style.display = 'block';
//     } catch (e) {
//       console.error('Embed fix error:', e);
//     }
//   }
// });



// console.log("📦 Running final SingleFile capture (isolated tab)…");
// await captureWithSingleFile(sfPage, outdir, "singleFile.html");

// // Close the SingleFile-only tab; main page stays untouched
// await sfPage.close();


console.log("🔄 Preparing clean environment for SingleFile (isolated tab)…");

const sfPage = await page.browser().newPage();

try {
  const ua = await page.userAgent();
  await sfPage.setUserAgent(ua);
} catch {}

try {
  const cookies = await page.cookies();
  if (cookies.length) await sfPage.setCookie(...cookies);
} catch {}

console.log("🔄 Preloading SingleFile hook on new tab…");
await sfPage.evaluateOnNewDocument(SINGLEFILE_HOOK);
await sfPage.evaluateOnNewDocument(`
  ${SINGLEFILE_SCRIPT}
  window.singlefile = singlefile;
  window.singlefileInstance = singlefile;
`);

console.log("🔄 Loading target URL in SingleFile tab…");
await sfPage.setJavaScriptEnabled(true);
await sfPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

// ▶️ Expand "Read full story" / "Show full article"
await clickExpandableContent(sfPage);

// 🕒 Wait for recommended / must-watch widgets
await sfPage.evaluate(async () => {
  const selector = '.recommended__widget, .AiRecommended_recommended__widget__ZkRo0, .MustWatchContainer, #tab-video-wrapper-plugin';
  const timeout = 6000;
  const start = Date.now();
  while (!document.querySelector(selector) && Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }
});

// 🚀 Scroll page to load lazy iframes
await sfPage.evaluate(async () => {
  const total = document.body.scrollHeight;
  const vp = window.innerHeight;
  for (let y = 0; y < total; y += vp / 2) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 200));
  }
  window.scrollTo(0, 0);
});
await sleep(600);


// ⭐ Hero media click-out for India Today story
await sfPage.evaluate(() => {
    const heroSelector =
      '.Story_srtymos__8Hq2k.Story_videoassocstry__V8I1i .Story_associate__image__bYOH_.topImage';
    const hero = document.querySelector(heroSelector);
    if (!hero) return;
  
    if (hero.hasAttribute('data-hero-clickout-processed')) return;
    hero.setAttribute('data-hero-clickout-processed','1');
      // Get embed URL from JSON-LD
    let videoHref = null;
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
         if (item && item['@type'] === 'VideoObject') {
            videoHref = videoHref || item.embedUrl || item.contentUrl || item.url;
          }
        });
     } catch(e) {
        // ignore parse errors
      }
    });
  
    if (!videoHref) {
      videoHref = location.href;
    }
  
   const img = hero.querySelector('img');
    if (!img) return;
  
    const link = document.createElement('a');
    link.href = videoHref;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.style.display = 'block';
    link.style.position = 'relative';
    link.style.textDecoration = 'none';
  
    img.replaceWith(link);
    link.appendChild(img);
      // Add play icon overlay
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.top = '50%';
    overlay.style.left = '50%';
    overlay.style.transform = 'translate(-50%, -50%)';
    overlay.style.width = '64px';
    overlay.style.height = '64px';
    overlay.style.borderRadius = '50%';
   overlay.style.border = '2px solid rgba(255,255,255,0.8)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
  
    const triangle = document.createElement('div');
   triangle.style.width = '0';
    triangle.style.height = '0';
    triangle.style.borderLeft = '20px solid rgba(255,255,255,0.9)';
    triangle.style.borderTop = '12px solid transparent';
   triangle.style.borderBottom = '12px solid transparent';
  
    overlay.appendChild(triangle);
    link.appendChild(overlay);
  });
  


/**
 * ⭐ CLICK-OUT embeds (main video + all inline videos)
 * Preserves videos as external links.
 */
await sfPage.evaluate(() => {

  const forbiddenZones = [
    '.recommended__widget',
    '.AiRecommended_recommended__widget__ZkRo0',
    '.MustWatchContainer'
  ].map(sel => document.querySelector(sel)).filter(Boolean);

  const insideForbidden = el =>
    forbiddenZones.some(zone => zone.contains(el));

  // 🔥 Must include the 3rd plugin video iframe
  const frames = Array.from(
    document.querySelectorAll(
      '.embedcode iframe, iframe.multy-video-iframe, #tab-video-wrapper-plugin iframe'
    )
  ).filter(iframe => {
    const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
    const rect = iframe.getBoundingClientRect();

    if (rect.width < 80 || rect.height < 80) return false;
    if (!src.includes('indiatoday.in/share/video')) return false;
    if (insideForbidden(iframe)) return false;
    if (iframe.closest('a')) return false;

    return true;
  });

  for (const iframe of frames) {
    try {
      const href = iframe.getAttribute('src') || iframe.getAttribute('data-src');
      if (!href) continue;

      const wrapper = document.createElement('div');
      wrapper.style.margin = '12px 0';

      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.style.display = 'block';
      link.style.textDecoration = 'none';

      const box = document.createElement('div');
      box.style.width = '100%';
      box.style.height = '240px';
      box.style.borderRadius = '6px';
      box.style.background = '#000';
      box.style.position = 'relative';

      const play = document.createElement('div');
      play.style.position = 'absolute';
      play.style.top = '50%';
      play.style.left = '50%';
      play.style.transform = 'translate(-50%, -50%)';
      play.style.width = '64px';
      play.style.height = '64px';
      play.style.borderRadius = '50%';
      play.style.border = '2px solid rgba(255,255,255,0.8)';
      play.style.display = 'flex';
      play.style.alignItems = 'center';
      play.style.justifyContent = 'center';

      const tri = document.createElement('div');
      tri.style.width = '0';
      tri.style.height = '0';
      tri.style.borderLeft = '20px solid rgba(255,255,255,0.9)';
      tri.style.borderTop = '12px solid transparent';
      tri.style.borderBottom = '12px solid transparent';

      play.appendChild(tri);
      box.appendChild(play);
      link.appendChild(box);
      wrapper.appendChild(link);

      iframe.replaceWith(wrapper);
    } catch (err) {
      console.error('click-out embed transform error:', err);
    }
  }
});

// 📦 Run SingleFile
console.log("📦 Running final SingleFile capture (isolated tab)…");
await captureWithSingleFile(sfPage, outdir, "singleFile.html");

await sfPage.close();


}


async function enableAdBlock(page) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (/taboola|doubleclick|adsystem|googlesyndication|playstream|outbrain/i.test(url))
      return req.abort();
    req.continue();
  });
}


async function clickIndiaTodayPseudoPlayButton(page) {
  // selector for the video thumbnail wrapper
  const selector = '.Story_associate__image__bYOH_.topImage';

  // Wait for the element to appear
  const elHandle = await page.$(selector);
  if (!elHandle) {
    console.log("⚠️ Play-button element not found.");
    return false;
  }

  // Read bounding box of the real element
  const box = await elHandle.boundingBox();
  if (!box) {
    console.log("⚠️ Could not read bounding box.");
    return false;
  }

  // Now compute the pseudo-element offset:
  // From CSS:
  // bottom: 10px;
  // right: 10px;
  // width: 40px;
  // height: 40px;
  //
  // We click near the center of this pseudo-element.
  const clickX = box.x + box.width - 10 - 20;   // 20 = width/2
  const clickY = box.y + box.height - 10 - 20;  // 20 = height/2

  await page.mouse.click(clickX, clickY);
  console.log("🖱️ Clicked CSS ::before play button");

  return true;
}


/**
 * Directly clicks any ad/video overlay close button (PlayStream, Taboola, Google Ads, etc.)
 * Fully resilient: handles detached nodes, dynamic overlays, and racey DOM updates.
 */
async function directClickAnyCloseButton(page) {
  try {
    const selector = [
      // 🎯 PlayStream and video overlays
      '[id^="ps-close-button"]',
      '[class*="ps-close-button"]',
      '[id^="ps-display-close-button"]',
      '[class*="ps-display-close-button"]',
    
      // 🎯 Taboola overlays
      '.tbl-next-up-closeBtn',
      '.tbl-next-up-closeBtn-wrapper',
      '.tbl-vignette-close-btn-wrp',
      '.tbl-close-btn',
      '[role="button"].tbl-vignette-close-btn-wrp',
    
      // 🎯 Google / DoubleClick / AdSense overlays
      'div[style*="position: absolute"][style*="border-radius"][style*="cursor: pointer"] svg path[d*="L38 12.83"]',
      'div[style*="cursor: pointer"][style*="background-color"][style*="z-index"][id^="Ne"][id*="_"]',
    
      // 🎯 Video.js close button
      '.vjs-close-button',
      '.ubp-close',
      'button.vjs-button[title*="close" i]',
      'button.vjs-close-button',
      '[class*="vjs"][class*="close" i]',
    
      // 🎯 Generic close buttons
      '[aria-label*="close" i]',
      'button[title*="close" i]',
      '[role="button"][class*="close" i]',
      'button.ICt_m',
      'button#close-pip',
      '.pip_close',
      'button.close-btn',
      'button[class*="close" i]',
    
      // 🎯 GDPR / custom <i> icon close buttons (NEW)
      '.close-icon',
      'i.close-icon',
      'i[data-label*="closed" i]',
      'i[class*="close" i]'
    
    ].join(',');

    const timeout = 6000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const handles = await page.$$(selector);
      if (!handles.length) {
        await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
        continue;
      }

      for (const handle of handles) {
        const exists = await handle.evaluate(el => !!el.isConnected).catch(() => false);
        if (!exists) continue;

        const visible = await handle.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 4 &&
            rect.height > 4 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            style.opacity !== "0"
          );
        }).catch(() => false);
        if (!visible) continue;

        try {
          await handle.evaluate(el =>
            el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
          );

          await handle.click({ delay: 30 });
          console.log("✅ Clicked close button (video/overlay/popup).");
          return true;
        } catch (err) {
          await page.evaluate(el => {
            try {
              el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            } catch {}
          }, handle).catch(() => {});

          console.log("⚠️ Fallback synthetic click sent to close button.");
          return true;
        }
      }

      await new Promise(r => setTimeout(r, 200));
    }

    console.log("⚠️ No visible close button clicked within timeout.");
    return false;
  } catch (err) {
    console.error("❌ directClickAnyCloseButton failed:", err.message);
    return false;
  }
}



/* -------------------------------------------------------------------------- */
/*                              MAIN EXECUTION FLOW                            */
/* -------------------------------------------------------------------------- */

async function runArchive(url) {
  const browser = await puppeteer.launch({
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    protocolTimeout: 180000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ],
  });

  try {
    const page = await browser.newPage();

	// ------------------------------------------------------------
	// Inject SingleFile BEFORE page loads (Critical placement)
	// ------------------------------------------------------------
	await page.evaluateOnNewDocument(SINGLEFILE_HOOK);
	await page.evaluateOnNewDocument(`
	  ${SINGLEFILE_SCRIPT}
	  window.singlefile = singlefile;
	`);



    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

	// ------------------------------------------------------------
	// Inject SingleFile into page BEFORE load
	// ------------------------------------------------------------
	await page.evaluateOnNewDocument(SINGLEFILE_HOOK);
	await page.evaluateOnNewDocument(`
	  ${SINGLEFILE_SCRIPT}
	  window.singlefile = singlefile;
	`);

    console.log(`🌐 Visiting: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });


    //Experiment
    await sleep(2000);


    //const matches = await findAllMatchingElements(page, SEARCH_TERMS);
    //if (matches.length > 0) {
      //await clickElements(page, matches);
      //await sleep(2000);
    //}

	  // await clickReadMore(page);
    // await clickPopups(page);
    //await directClickAnyCloseButton(page);
    // await removeCookiePopup(page);
    
    // await clickExpandableContent(page);
    await clickExpandableContent(page);
    // await sleep(1000);
    await hideStickyFooters(page);
    // await triggerLazyLoadScroll(page);    // <-- load embeds
    // await sleep(500);

    // await removeAvpVideo(page);
// =====================================================
//  ⛔ STOP ALL SITE JAVASCRIPT AFTER EXPANSION IS DONE
// =====================================================
console.log("⛔ Stopping all site JavaScript…");

// Freeze site JS alive
await page.evaluate(() => {
  // Stop timers
  window.setTimeout = () => {};
  window.setInterval = () => {};
  window.requestAnimationFrame = () => {};
  window.cancelAnimationFrame = () => {};
  window.onbeforeunload = null;
  window.onunload = null;

  // Block ANY event listeners
  const block = e => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  [
    "click",
    "touchstart", "touchend", "touchmove",
    "keydown", "keyup", "keypress",
    "beforeunload"
  ].forEach(evt => {
    window.addEventListener(evt, block, true);
  });

  // Disable mutation observers
  window.MutationObserver = class {
    constructor() {}
    observe() {}
    disconnect() {}
  };

  // Kill XHR and fetch
  window.fetch = () => new Promise(() => {});
  window.XMLHttpRequest = class {
    open() {}
    send() {}
  };

  console.log("JS freeze applied (window locked).");
});

// Fully disable JS execution for future operations
await page.setJavaScriptEnabled(false);

console.log("⛔ JavaScript disabled completely. Page frozen.");


    
    //await clickLoadMoreAndScroll(page);
    
    //await removeJioSaavnWidget(page);
    // await removeCookiePopup(page);
    // await clickPopups(page);

    // await directClickAnyCloseButton(page);
    // await clickBottomFooterButton(page);
    
    // await removeAllGoogleAds(page);
    // await clickReadMore(page);
    // await hideStickyFooters(page);
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
    await queue.updateJobStatus(job.id, ok ? "complete" : "failed", ok ? null : "Archive failed");
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

