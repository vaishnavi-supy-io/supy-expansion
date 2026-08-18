/**
 * Form regression tests. Run with: npm test
 *
 * These cover the four defects the form shipped with. The billing-entity one
 * is the reason this file exists: a rename used to silently clear every row
 * pointing at that entity, which is invisible until the request arrives wrong.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const dom = new JSDOM(html, { runScripts:'dangerously', url:'https://example.test/', pretendToBeVisual:true });
const w = dom.window, d = w.document;
w.confirm = () => true;
await new Promise(r => setTimeout(r, 300));

let pass=0, fail=0;
const check=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);
  console.log(`  ${ok?'PASS':'FAIL'}  ${n}${ok?'':`\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  ok?pass++:fail++;};
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
const set=(el,v,ev='input')=>{el.value=v;el.dispatchEvent(new w.Event(ev,{bubbles:true}));};

console.log('\n=== FIX 1: renaming a billing entity must not orphan rows ===');
click(d.querySelector('.tog[data-kind="branch"]'));
set(d.querySelector('#itemBody input[data-f="name"]'),'Marina Walk');
set(d.querySelector('#itemBody select[data-f="type"]'),'Outlet','change');
set(d.querySelector('#itemBody input[data-f="cloneFrom"]'),'JLT');

const radio = d.querySelector('input[name=entity][value="Different legal entity"]');
radio.checked = true;
radio.dispatchEvent(new w.Event('change',{bubbles:true}));

const entBlock = d.querySelector('#entityList .ent');
const entId    = entBlock.getAttribute('data-ent');
set(entBlock.querySelector('input[data-ef="name"]'), 'Marina Hospitality');   // typo

const sel = () => d.querySelector('#itemBody select[data-f="billsUnder"]');
set(sel(), entId, 'change');
check('row points at the entity', sel().value, entId);

// correcting the typo is what used to silently wipe the mapping
set(d.querySelector('#entityList .ent input[data-ef="name"]'), 'Marina Hospitality LLC');
check('row STILL points at the entity after rename', sel().value, entId);
check('dropdown shows the corrected name',
  [...sel().options].filter(o=>o.value===entId).map(o=>o.textContent), ['Marina Hospitality LLC']);

console.log('\n=== removing an entity does clear the rows pointing at it ===');
click(d.querySelector('#entityList .ent .xbtn'));
check('row cleared after its entity is removed', sel().value, '');

console.log('\n=== FIX 2: documents banner ===');
const note = d.getElementById('docsNote').textContent;
check('no longer claims "All optional"', note.includes('All optional'), false);
check('states what is actually required', note.includes('registration and VAT numbers'), true);

console.log('\n=== FIX 3: per-entity file cap ===');
// CONFIG is a const, so it is read from source rather than off window.
const cfg = k => Number((new RegExp(k + ':\\s*(\\d+)').exec(html) || [])[1]);
check('maxFilesPerEntity present', cfg('maxFilesPerEntity'), 6);
check('three KSA entities (9 docs) now fit', 9 <= cfg('maxFiles'), true);

console.log('\n=== FIX 4: discard guard fires before wiping rows ===');
let asked = null;
w.confirm = msg => { asked = msg; return false; };        // user declines
const tog = d.querySelector('.tog[data-kind="branch"]');
click(tog);
check('confirm was shown', /clears the 1 row/.test(asked || ''), true);
check('toggle stayed on when declined', tog.getAttribute('aria-checked'), 'true');
check('row survived', d.querySelector('#itemBody input[data-f="name"]').value, 'Marina Walk');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
