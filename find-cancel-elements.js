#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { setTimeout as sleep } from 'timers/promises';

/* -------------------- Configuration -------------------- */
const SEARCH_TERMS = ['cancel', 'close', 'dismiss', 'reject', 'decline', 'no thanks'];
const CLICK_DELAY_MS = 100;

/* -------------------- Utility Functions -------------------- */

/**
 * Check if an element is considered clickable.
 * @param {Element} el
 * @returns {boolean}
 */
function isClickable(el) {
  const tag = el.tagName.toLowerCase();
  const clickableTags = ['button', 'a', 'input'];
  if (clickableTags.includes(tag)) return true;
  if (el.hasAttribute('onclick')) return true;
  if (el.getAttribute('role') === 'button') return true;
  if (el.tabIndex >= 0) return true;
  return false;
}

/**
 * Determine if an element’s text matches any search term.
 * @param {string} text
 * @param {string[]} terms
 * @returns {boolean}
 */
function matchesTerm(text, terms) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return terms.some(term => lower.includes(term.toLowerCase()));
}

/**
 * Find clickable elements containing our search terms within a frame.
 * @param {Frame} frame
 * @param {string[]} searchTerms
 */
async function findMatchingClickableElements(frame, searchTerms) {
  return frame.$$eval('*', (elements, searchTerms) => {
    const results = [];
    const terms = searchTerms.map(t => t.toLowerCase());

    const isClickable = el => {
      const tag = el.tagName.toLowerCase();
      const clickableTags = ['button', 'a', 'input'];
      if (clickableTags.includes(tag)) return true;
      if (el.hasAttribute('onclick')) return true;
      if (el.getAttribute('role') === 'button') return true;
      if (el.tabIndex >= 0) return true;
      return false;
    };

    for (const el of elements) {
      if (!isClickable(el)) continue;
      const text = (el.textContent || el.value || '').trim();
      if (!text) continue;

      const match = terms.some(t => text.toLowerCase().includes(t));
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
  }, searchTerms);
}

/**
 * Find all matching clickable elements across all frames.
 * @param {Page} page
 * @param {string[]} searchTerms
 */
async function findAllMatchingElements(page, searchTerms) {
  const matches = [];
  for (const frame of page.frames()) {
    try {
      const found = await findMatchingClickableElements(frame, searchTerms);
      matches.push(...found);
    } catch {
      // ignore cross-origin frames
    }
  }
  return matches;
}

/**
 * Perform a real mouse click at given coordinates.
 * @param {Page} page
 * @param {number} x
 * @param {number} y
 */
async function simulateMouseClick(page, x, y) {
  const mouse = page.mouse;
  await mouse.move(x, y, { steps: 5 });
  await mouse.down();
  await sleep(40);
  await mouse.up();
  await sleep(CLICK_DELAY_MS);
}

/**
 * Click all found elements with realistic mouse events.
 * @param {Page} page
 * @param {Array} elements
 */
async function clickElements(page, elements) {
  for (const el of elements) {
    try {
      console.log(`🖱️ Clicking <${el.tag}> "${el.text}" at (${el.x.toFixed(0)}, ${el.y.toFixed(0)})`);
      await simulateMouseClick(page, el.x, el.y);
    } catch (err) {
      console.warn(`⚠️ Failed to click "${el.text}": ${err.message}`);
    }
  }
}

/**
 * Pretty print matching elements.
 * @param {Array} elements
 * @param {string[]} terms
 */
function printElements(elements, terms) {
  console.log('\n' + '='.repeat(70));
  console.log(`Search Terms: ${terms.join(', ')}`);
  console.log(`Found ${elements.length} clickable element(s)`);
  console.log('='.repeat(70) + '\n');

  elements.forEach((el, i) => {
    console.log(`${i + 1}. <${el.tag}> "${el.text}"`);
  });
}

/* -------------------- Main -------------------- */
async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node click-cancel.js <URL>');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'

    ],
  });

  try {
    const page = await browser.newPage();
    console.log(`🌐 Visiting: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 0 });

    console.log('🔍 Searching for clickable elements...');
    const matches = await findAllMatchingElements(page, SEARCH_TERMS);

    printElements(matches, SEARCH_TERMS);

    console.log('\n⚡ Simulating real clicks...\n');
    await clickElements(page, matches);

    console.log('✅ Done.');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browser.close();
  }
}

main();

