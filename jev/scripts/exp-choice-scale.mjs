#!/usr/bin/env node
// Can a Choice pick the right button out of a real page's worth of them?
//
// This is the feasibility number for driving Playwright with Jev. The idea: instead of Claude
// reading a whole accessibility snapshot to decide what to click, code extracts the interactive
// elements, Jev picks one as a Choice, and the snapshot never enters a Claude context. Jev has no
// image support today (confirmed by Nathan, planned for a later version), so the accessibility
// tree is the input, and it is already text.
//
// Everything hinges on how many options a Choice tolerates. A real page has dozens of clickable
// elements. The docs give no cap and Score is capped at 2-10 levels, so a cap on Choice is
// plausible and would decide the whole design.
//
// Measured: does it error, does latency hold, and does it still pick CORRECTLY as the option count
// grows. The last one is the real question — an answer that arrives in 400ms and is wrong is worse
// than no answer.

import assert from 'node:assert';
import { askJev } from './lib.mjs';

// Realistic distractor labels from the chrome of an e-commerce / SaaS page. Deliberately including
// near-misses ("Save for later", "Save card", "Save and continue") because the easy version of this
// test is worthless: on a real page the wrong answers look like the right one.
const DISTRACTORS = [
  'Home', 'About us', 'Contact', 'Careers', 'Blog', 'Help centre', 'Sign in', 'Create account',
  'Search', 'My account', 'Order history', 'Wishlist', 'Compare', 'Track order', 'Returns',
  'Gift cards', 'Store locator', 'Newsletter signup', 'Accept cookies', 'Manage preferences',
  'Privacy policy', 'Terms of service', 'Accessibility', 'Sitemap', 'Language: English',
  'Currency: SGD', 'Share on Facebook', 'Share on X', 'Copy link', 'Print page',
  'Save for later', 'Save card', 'Save and continue', 'Add to wishlist', 'Remove item',
  'Apply promo code', 'Estimate shipping', 'Edit address', 'Change payment method', 'Cancel order',
  'Continue shopping', 'View cart', 'Proceed to checkout', 'Back to basket', 'Update quantity',
  'Subscribe and save', 'One-time purchase', 'Chat with us', 'Request a callback', 'Report a problem',
  'Leave a review', 'Read reviews', 'Ask a question', 'Size guide', 'Delivery information',
  'Follow store', 'Notify me', 'Pre-order', 'Out of stock', 'Choose a variant',
  'Filter results', 'Sort by price', 'Clear filters', 'Load more', 'Previous page', 'Next page',
  'Zoom image', 'View gallery', 'Play video', 'Mute', 'Fullscreen', 'Close dialog',
  'Skip to content', 'Open menu', 'Close menu', 'Expand details', 'Collapse details',
  'Download invoice', 'Email receipt', 'Add another item', 'Split payment', 'Use store credit',
  'Verify identity', 'Resend code', 'Use a different card', 'Edit billing address', 'Add note',
  'Schedule delivery', 'Collect in store', 'Express delivery', 'Standard delivery', 'Gift wrap',
  'Apply loyalty points', 'Join rewards', 'View points balance', 'Redeem voucher', 'Terms apply',
  'Manage subscriptions', 'Pause subscription', 'Skip next delivery', 'Change frequency',
  'Contact seller', 'View seller profile', 'See similar items', 'Recently viewed', 'Top rated',
];

// Three goals with an unambiguous correct answer, each phrased the way an agent would phrase it.
const CASES = [
  { goal: 'Complete the purchase and pay for the items now', correct: 'Place order and pay' },
  { goal: 'Permanently delete the account and all its data', correct: 'Delete my account' },
  { goal: 'Export the current report as a spreadsheet', correct: 'Download as CSV' },
];

const elements = (n, correct) => {
  // The correct option sits in the MIDDLE of the list, not first or last, so position cannot be
  // doing the work. Keys are refs, the way Playwright identifies an element.
  const picked = DISTRACTORS.slice(0, n - 1);
  const at = Math.floor(picked.length / 2);
  const labels = [...picked.slice(0, at), correct, ...picked.slice(at)];
  return Object.fromEntries(labels.map((l, i) => [`e${i + 1}`, l]));
};

export function selftest() {
  const e = elements(11, 'TARGET');
  assert.strictEqual(Object.keys(e).length, 11);
  const vals = Object.values(e);
  assert.strictEqual(vals.filter((v) => v === 'TARGET').length, 1, 'exactly one correct option');
  assert.notStrictEqual(vals[0], 'TARGET', 'the answer must not be first');
  assert.notStrictEqual(vals.at(-1), 'TARGET', 'the answer must not be last');
  assert.ok(DISTRACTORS.length >= 100, 'need enough distractors to reach the top bucket');
  assert.strictEqual(new Set(DISTRACTORS).size, DISTRACTORS.length, 'duplicate labels would make a key collide');
  return 'exp-choice-scale selftest OK';
}
// The selftest must run without a key: it checks the fixture, not the API.
if (process.argv.includes('--selftest')) { console.log(selftest()); process.exit(0); }

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

console.log(selftest());
console.log('Choice option-count scaling, 3 goals x 3 trials each\n');
console.log('  options  correct  median ms  mean conf  mean p(correct)  notes');

let spend = 0;
for (const n of [5, 12, 25, 50, 100]) {
  let right = 0; let tried = 0; const times = []; const confs = []; const ps = [];
  let note = '';
  for (const c of CASES) {
    const criteria = elements(n, c.correct);
    const answerKey = Object.entries(criteria).find(([, v]) => v === c.correct)[0];
    for (let t = 0; t < 3; t++) {
      const t0 = performance.now();
      try {
        const { answers, cost } = await askJev(
          `You are an agent operating a web page. Goal: ${c.goal}`,
          { click: { type: 'choice', instructions: `Which element should be clicked to: ${c.goal}`, criteria } },
          key);
        times.push(performance.now() - t0);
        spend += cost ?? 0;
        const a = answers.click;
        tried++;
        if (a.choice === answerKey) right++;
        if (typeof a.confidence === 'number') confs.push(a.confidence);
        if (a.probabilities && typeof a.probabilities[answerKey] === 'number') ps.push(a.probabilities[answerKey]);
      } catch (e) {
        note = `REFUSED: ${e.message.slice(0, 70)}`;
        tried++;
      }
    }
  }
  const mid = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
  console.log(`  ${String(n).padStart(7)}  ${String(right).padStart(3)}/${tried}  `
    + `${mid(times).toFixed(0).padStart(9)}  ${avg(confs).toFixed(2).padStart(9)}  `
    + `${avg(ps).toFixed(2).padStart(15)}  ${note}`);
}
console.log(`\ntotal spend: $${spend.toFixed(5)}`);
console.log('\nWhat this decides: if accuracy holds at 50-100 options, code can hand Jev a whole');
console.log('page of interactive elements. If it degrades, the candidate list has to be narrowed');
console.log('first, which puts the hard part back in the caller.');
