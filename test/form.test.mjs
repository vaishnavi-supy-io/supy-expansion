/**
 * Form regression tests. Run with: npm test
 *
 * Driven against the real index.html in jsdom, asserting on the DOM rather than
 * on internals, so they check what a user actually sees.
 *
 * The billing-entity test is the reason this file exists: referencing entities
 * by name meant correcting a typo silently cleared every line pointing at that
 * entity. Split billing is the form's whole purpose, so that failure was both
 * invisible and expensive. It regressed once already when the UI was
 * redesigned, which is exactly why it is pinned here.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { runScripts:'dangerously', url:'https://example.test/', pretendToBeVisual:true });
const w = dom.window, d = w.document;
await new Promise(r => setTimeout(r, 300));

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
const set = (el, v, ev='input') => { el.value = v; el.dispatchEvent(new w.Event(ev, { bubbles:true })); };

console.log('\n=== catalogue renders ===');
const prodToggles = d.querySelectorAll('#prodBody .tog[data-item]');
const svcToggles  = d.querySelectorAll('#svcBody .tog[data-item]');
check('4 products offered', prodToggles.length, 4);
check('2 features offered', svcToggles.length, 2);
check('outlet is first product', prodToggles[0].dataset.item, 'outlet');

console.log('\n=== renaming a billing entity must not orphan the lines ===');
click(prodToggles[0]);                                  // switch on Outlet

const radio = d.querySelector('input[name=entity][value="Different legal entity"]');
radio.checked = true;
radio.dispatchEvent(new w.Event('change', { bubbles:true }));

const entBlock = d.querySelector('#entityList .ent');
const entId = entBlock.getAttribute('data-ent');
set(entBlock.querySelector('input[data-ef="name"]'), 'Marina Hospitality');   // typo

const sel = () => d.querySelector('#prodBody select[data-alloc-ent]');
check('an allocation row appeared', Boolean(sel()), true);
set(sel(), entId, 'change');
check('line points at the entity', sel().value, entId);

set(d.querySelector('#entityList .ent input[data-ef="name"]'), 'Marina Hospitality LLC');
check('line STILL points at it after rename', sel().value, entId);
check('dropdown shows the corrected name',
  [...sel().options].filter(o => o.value === entId).map(o => o.textContent),
  ['Marina Hospitality LLC']);

console.log('\n=== removing an entity clears its lines ===');
click(d.querySelector('#entityList .ent .xbtn'));
// With no entities left there is nothing to choose, so the picker goes away
// entirely rather than sitting there offering a deleted entity.
check('entity picker removed with the last entity', sel(), null);

// Adding a fresh entity must not resurrect the old selection.
d.getElementById('addEntBtn').dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
set(d.querySelector('#entityList .ent input[data-ef="name"]'), 'Second Entity LLC');
check('picker returns blank, not pointing at the deleted entity', sel() && sel().value, '');

console.log('\n=== documents banner states what is required ===');
const note = d.getElementById('docsNote').textContent;
check('does not claim "All optional"', note.includes('All optional'), false);

console.log('\n=== per-entity upload cap ===');
const cfg = k => Number((new RegExp(k + ':\\s*(\\d+)').exec(html) || [])[1]);
check('maxFilesPerEntity is set', cfg('maxFilesPerEntity'), 6);
check('three KSA entities (9 docs) fit', 9 <= cfg('maxFiles'), true);

console.log('\n=== draft + idempotency wiring present ===');
check('save button exists', Boolean(d.getElementById('saveBtn')), true);
check('resume reads ?draft=', html.includes("get('draft')"), true);
check('payload carries a nonce', html.includes('submissionNonce'), true);
check('endpoint is configured', /webhookUrl:\s*'https:\/\//.test(html), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
