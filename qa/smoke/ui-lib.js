'use strict';

/**
 * ui-lib.js — shared REAL-BROWSER interaction helpers for the feature sweep.
 *
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * The module smokes drive a real browser and assert real business outcomes, but
 * they mostly reach the API through the page's session rather than clicking and
 * typing. That catches broken flows — it does NOT catch the two bugs a tester
 * actually reported first:
 *
 *   "Create job option is not available"   — the API returned 200 all day. The
 *       PAGE hid its own button, because permissionsFromSession read the
 *       /api/auth/me envelope instead of the user inside it. A page that loads
 *       200 with an invisible button is indistinguishable from a healthy page
 *       unless something looks for the control.
 *
 *   "Unable to type in the new job form"   — builds clean, renders clean. The
 *       onChange handler threw on the FIRST KEYSTROKE, so the field silently
 *       discarded input and merely looked disabled.
 *
 * Neither is visible to an API assertion. Both are trivially visible to a browser
 * that clicks the control and types into the field, then READS THE VALUE BACK.
 *
 * These helpers make that cheap enough to do in every module.
 */

/**
 * assertControlVisible(page, ok, selectors, label)
 *   A page returning 200 proves nothing about whether a user can act on it.
 *   Accepts a list of candidate selectors (text/href variants) and passes when any
 *   is actually visible — not merely present in the DOM.
 */
async function assertControlVisible(page, ok, selectors, label) {
  let found = null;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) { found = sel; break; }
  }
  return ok(!!found, label, found ? `matched ${found}` : `none visible of: ${selectors.join(' | ')}`);
}

/**
 * typeAndReadBack(page, ok, selector, value, label)
 *   TYPES (keystroke by keystroke, not .fill()) and reads the value back. The
 *   typing bug we shipped threw on every keypress; .fill() sets the value directly
 *   via the DOM and can mask exactly that failure, so this uses .type().
 */
async function typeAndReadBack(page, ok, selector, value, label) {
  const input = page.locator(selector).first();
  if (!(await input.isVisible().catch(() => false))) {
    return ok(false, label, `input not visible: ${selector}`);
  }
  await input.click().catch(() => {});
  await input.fill('').catch(() => {});
  await input.type(value, { delay: 20 }).catch(() => {});
  const back = await input.inputValue().catch(() => null);
  return ok(back === value, label, `typed "${value}" read back "${back}"`);
}

/**
 * openInCleanBrowser(browser, url, watch, sink, tag)
 *   Opens a URL with NO cookies and NO session — the only way to see what an
 *   outsider (candidate, invited employee) actually sees. Returns { status, text }.
 */
async function openInCleanBrowser(browser, url, watch, sink, tag = 'anon') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (watch) watch(page, tag, sink);
  let status = 0;
  let text = '';
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    status = resp ? resp.status() : 0;
    text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  } catch (e) {
    text = `navigation failed: ${e.message}`;
  }
  await ctx.close().catch(() => {});
  return { status, text };
}

module.exports = { assertControlVisible, typeAndReadBack, openInCleanBrowser };
