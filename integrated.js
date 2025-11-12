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
const SEARCH_TERMS =  ["close", "dismiss", "Don't Allow", "don't allow", "dont allow", "Later", "ok", "Reject",  "decline", "no thanks", "I'll Give Later"];
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



//ClickPopupsButton
async function clickPopups(page) {
  console.log("🔍 Checking for popups...");

  const matches = await findAllMatchingElements(page, SEARCH_TERMS);
  if (matches.length === 0) {
    console.log("ℹ️ No clickable popups found.");
    return;
  }

  // Remove duplicates by text
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
    const matched = SEARCH_TERMS.filter(t =>
      el.text.toLowerCase().includes(t.toLowerCase())
    );
    console.log(`   → <${el.tag}> "${el.text}" [${matched.join(", ")}]`);
  }

  // ✅ Click only the first one that’s visible
  const first = unique[0];
  if (!first) {
    console.log("ℹ️ No valid popup button to click.");
    return;
  }

  console.log(`🖱️ Clicking popup button once: "${first.text}"`);
  await clickElements(page, [first]);
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
    "show full article",
    "view full story",
    "load more",
    "continue reading",
    "show more",
    "expand"
  ];

  console.log("🔍 Searching for expandable content triggers...");

  const clicked = await page.evaluate(async (terms) => {
    const lower = (s) => (s || "").toLowerCase();

    const isVisible = (el) => {
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


    // 🧩 2️⃣ Generic fallback for all other “expand” buttons
    if (!btn) {
      const sel = "button, a, [role='button'], span[role='button'], div, span";
      const all = Array.from(document.querySelectorAll(sel));

      btn = all.find((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        if (!text || text.length > 80) return false;
        const t = lower(text);
        return terms.some((term) => t.includes(lower(term))) && isVisible(el);
      });
    }

    if (!btn) return false;

    btn.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 200)); // brief delay

    try {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) =>
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
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
  await sleep(1000);

  // 🧩 Verify expansion by paragraph count
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
 * Clicks "Read More" button on pages like News18.
 * Covers both div/span wrapper patterns and generic ones.
 */
async function clickReadMore(page) {
  console.log("🔍 Looking specifically for a 'Read More' button...");

  const success = await page.evaluate(async () => {
    const isVisible = (el) => {
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

    // Try the known News18-specific structure first
    let btn =
      document.querySelector("div[id^='readmore_story'] .news18_read_more") ||
      document.querySelector(".news18_read_more") ||
      document.querySelector("div[id^='readmore_story'], .rmbtn-box");

    if (btn && !isVisible(btn)) btn = null;

    // If not found, try generic matches
    if (!btn) {
      const candidates = Array.from(document.querySelectorAll("button, a, span, div"));
      btn = candidates.find((el) => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return text === "read more" || text.includes("read more");
      });
    }

    if (!btn) {
      console.log("❌ No 'Read More' found in DOM.");
      return false;
    }

    btn.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 200)); // brief delay before click

    // Dispatch full event chain for reliability
    try {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
        btn.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
        );
      });
    } catch {
      btn.click();
    }

    console.log("✅ Clicked Read More:", btn.outerHTML.slice(0, 120));
    return true;
  });

  if (success) {
    console.log("🖱️ 'Read More' click executed successfully.");
    await sleep(1000);
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




async function hideStickyFooters(page) {
  await page.evaluate(() => {
    // Remove the known bottom sticky navigation bar completely
    document.querySelectorAll('.m-mb, .m-bm, .bottom_sticky_nav').forEach(el => {
      if (
        el.classList.contains('m-mb') ||
        el.classList.contains('m-bm') ||
        el.classList.contains('bottom_sticky_nav')
      ) {
        el.remove();
      }
    });

    // Inject or update footer/bottom nav hide style (keeps original functionality)
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
      .m-bm {
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
  fs.mkdirSync(outdir, { recursive: true });
  console.log(`\n🗄️  Starting archive save in: ${outdir}`);

  // ✅ Capture pristine DOM early before modification
  const rawHtml = await page.content();
  const realPath = path.join(outdir, "page_raw.html");
  fs.writeFileSync(realPath, rawHtml, "utf8");
  console.log(`💾 Saved original HTML snapshot: ${realPath}`);

	
  // Now modify the live page
  await dismissOneSignalSlidedown(page);
  await removeOneSignalBell(page);
  await clickPopups(page);

  // --- inject a literal <script> into the saved HTML so archived file contains it ---
  const injectionId = "__injected_nav_blocker_fe__";
  const injectionScript = `<script id="${injectionId}">
    try {
      if (window.navigation) {
        try {
          window.navigation.onnavigate = e => {
            if (e.sourceElement) return;
            e.preventDefault();
          };
        } catch (err) {
          try {
            window.navigation.addEventListener?.('navigate', ev => {
              if (ev.sourceElement) return;
              ev.preventDefault();
            });
          } catch (__) {}
        }
      }
    } catch (ignore) {}
  </script>`;

  await triggerLazyLoadScroll(page);

  // ✅ Capture modified DOM now
  let modifiedHtml = await page.content();

  // Inject navigation-blocker script safely
  if (!/id=["']__injected_nav_blocker_fe__["']/.test(modifiedHtml)) {
    if (/<head[^>]*>/i.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(/<head[^>]*>/i, m => `${m}\n${injectionScript}`);
    } else if (/<html[^>]*>/i.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(/<html[^>]*>/i, m => `${m}\n<head>\n${injectionScript}\n</head>\n`);
    } else {
      modifiedHtml = `${injectionScript}\n${modifiedHtml}`;
    }
  }
  //await hideStickyFooters(page);

  await clickBottomFooterButton(page);
  //await removeFooterAds(page);


  await removeAllGoogleAds(page);

  const htmlPath = path.join(outdir, "page.html");
  fs.writeFileSync(htmlPath, modifiedHtml, "utf8");
  console.log(`✅ Saved sanitized HTML: ${htmlPath}`);

  //await triggerLazyLoadScroll(page);
  //await clickPopups(page);
  //await clickVisualCloseButton(page);
  //await directClickAnyCloseButton(page);
  //await page.setBypassCSP(true);
  //await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {});

  await clickExpandableContent(page); 
  
  //await hideStickyFooters(page);
  await sleep(300);


// 🧩 Fix ThePrint white PDF/screenshot issue
await page.evaluate(() => {
  document.querySelectorAll('html, body, main, article, section, div').forEach(el => {
    const s = getComputedStyle(el);
    if (s.transform && s.transform !== 'none') el.style.transform = 'none';
    if (s.overflow.includes('hidden')) el.style.overflow = 'visible';
    if (s.height && s.height !== 'auto') el.style.height = 'auto';
    if (s.maxHeight && s.maxHeight !== 'none') el.style.maxHeight = 'none';
  });
  document.body.style.background = '#fff';
  document.documentElement.style.background = '#fff';
  window.scrollTo(0, 0);
});




// 🧭 ensure scroll, animations, and network quiet before screenshot
await page.evaluate(() => new Promise(resolve => {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    setTimeout(resolve, 1200); // small buffer for sticky/animation settle
  });
}));
await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {});
//await clickBottomFooterButton(page); 
  //await removeFooterAds(page);
	const screenshotPath = path.join(outdir, "screenshot.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✅ Saved Screenshot: ${screenshotPath}`);

  //try {
    //await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 });
  //} catch {}
  //await sleep(400);

  await triggerLazyLoadScroll(page);
  //await clickPopups(page);
  //await clickVisualCloseButton(page);
  //await directClickAnyCloseButton(page);
  //await removeBackToTopButton(page);
  //await removeAdWrappers(page);
  //await sleep(300);


  const pdfPath = path.join(outdir, "page.pdf");

	// Wait for layout to stabilize before PDF
	await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});



// await page.evaluate(() => {
//   try {
//     let style = document.getElementById('__hide_headers_style');
//     if (!style) {
//       style = document.createElement('style');
//       style.id = '__hide_headers_style';
//       document.head.appendChild(style);
//     }

//     style.textContent = `
//       /* Hide sticky headers, navbars, and floating menus */
//       header,
//       nav,
//       [class*="header"],
//       [class*="top-bar"],
//       [class*="menu-bar"],
//       [class*="headMenu"],
//       [class*="fixedNav"],
//       [class*="leftFixedNav"],
//       [class*="leftSecNav"],
//       [class*="moreNav"],
//       [id*="sticky"],
//       [id*="header"],
//       [id*="navbar"],
//       [style*="position:fixed"],
//       [style*="position: sticky"] {
//         display: none !important;
//         visibility: hidden !important;
//         height: 0 !important;
//         min-height: 0 !important;
//         overflow: hidden !important;
//         position: static !important;
//       }

//       /* Restore normal flow */
//       html, body {
//         height: auto !important;
//         overflow: visible !important;
//       }

//       main, article, section {
//         height: auto !important;
//         overflow: visible !important;
//         transform: none !important;
//       }

//       /* Force content containers to unclip */
//       [style*="overflow:hidden"],
//       [style*="overflow: clip"] {
//         overflow: visible !important;
//       }
//     `;
//   } catch (err) {
//     console.warn("⚠️ Failed to inject header-hide styles:", err.message);
//   }
// });



	//await hideStickyFooters(page);
	//await removeIzootoBranding(page);
	//await removeFloatingExplainers(page);


	// ✅ Minimal anti-clip patch for screen PDFs
	await page.evaluate(() => {
	  document.querySelectorAll('*').forEach(e => {
	    const s = getComputedStyle(e);
	    if (s.overflow.includes('hidden')) e.style.overflow = 'visible';
	    if (['fixed','sticky'].includes(s.position)) e.style.position = 'static';
	  });
	  document.body.style.overflow = document.documentElement.style.overflow = 'visible';
	});
	await sleep(300); // small repaint buffer


// Fix ThePrint white rendering (GPU layer + overflow issue)
await page.evaluate(() => {
  document.querySelectorAll('html, body, main, article, section, div').forEach(el => {
    const s = getComputedStyle(el);
    if (s.transform && s.transform !== 'none') el.style.transform = 'none';
    if (s.overflow.includes('hidden')) el.style.overflow = 'visible';
    if (s.height && s.height !== 'auto') el.style.height = 'auto';
    if (s.maxHeight && s.maxHeight !== 'none') el.style.maxHeight = 'none';
  });
  document.body.style.background = '#fff';
  document.documentElement.style.background = '#fff';
});


	await sleep(3000);
	await page.setViewport({ width: 1440, height: 900 });
	await page.emulateMediaType('screen');
	await page.pdf({
	  path: pdfPath,
	  format: 'A4',
	  margin: {bottom: "8px"},
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
  fs.writeFileSync(path.join(outdir, "meta.json"), JSON.stringify(meta, null, 2));
  console.log("🧾 Saved meta.json");
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


/**
 * Directly clicks any ad/video overlay close button (PlayStream, Taboola, Google Ads, etc.)
 * Fully resilient: handles detached nodes, dynamic overlays, and racey DOM updates.
 */
async function directClickAnyCloseButton(page) {
  try {
    const selector = [
      // 🎯 PlayStream and in-video overlays
      '[id^="ps-close-button"]',
      '[class*="ps-close-button"]',
      '[id^="ps-display-close-button"]',
      '[class*="ps-display-close-button"]',

      // 🎯 Taboola overlays
      '.tbl-next-up-closeBtn',
      '.tbl-next-up-closeBtn-wrapper',
      '.tbl-vignette-close-btn-wrp',   // added
      '.tbl-close-btn',                // added (in case SVG is directly clickable)
      '[role="button"].tbl-vignette-close-btn-wrp', // added for role-based close divs

      // 🎯 Google / DoubleClick / AdSense overlays
      'div[style*="position: absolute"][style*="border-radius"][style*="cursor: pointer"] svg path[d*="L38 12.83"]', // typical close X path
      'div[style*="cursor: pointer"][style*="background-color"][style*="z-index"][id^="Ne"][id*="_"]',

      // 🎯 Generic fallback
      '[aria-label*="close" i]',
      '[role="button"][class*="close" i]',
      'button.ICt_m', 
      // 🎯 Picture-in-picture & generic dismiss buttons
      '#close-pip',
      'button#close-pip',
      'button.pip_close',
      'button.close-btn',
      'button[class*="close" i]',   

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
        const stillExists = await handle.evaluate(el => !!el.isConnected).catch(() => false);
        if (!stillExists) continue;

        const visible = await handle.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
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

          // Try DOM click first
          await handle.click({ delay: 40 });
          console.log("✅ Clicked ad/overlay close button directly.");
          return true;
        } catch {
          // Fallback: synthetic event dispatch
          await page.evaluate(el => {
            try {
              const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
              el.dispatchEvent(evt);
            } catch {}
          }, handle).catch(() => {});
          console.log("✅ Fallback dispatched manual click event to close button.");
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
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });





    console.log(`🌐 Visiting: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });
    //Experiment
    await sleep(2000);


    //const matches = await findAllMatchingElements(page, SEARCH_TERMS);
    //if (matches.length > 0) {
      //await clickElements(page, matches);
      //await sleep(2000);
    //}

	  
    //await clickPopups(page);
    //await directClickAnyCloseButton(page);
    await clickExpandableContent(page);
    await clickReadMore(page);
    //await clickLoadMoreAndScroll(page);
    
    //await removeJioSaavnWidget(page);

    await clickBottomFooterButton(page);
    
    await removeAllGoogleAds(page);
    
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

