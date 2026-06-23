'use strict';

/*
 * mergeFields.test.js — PURE test for the merge-field resolver + token renderer
 * (../mergeFields.js). No DB, no network, no jest.
 *
 *   node backend/src/hr/letters/__tests__/mergeFields.test.js
 *
 * Proves (per docs/features/09 §7 + §9):
 *   - resolveMergeData resolves the §7 catalog namespaces from raw rows;
 *   - locale-aware formatting: en-IN → dd/MM/yyyy + ₹ + Indian grouping;
 *     en-NZ → dd/MM/yyyy + NZ$;
 *   - comp.* is MASKED to "••••" without perms.canViewCompensation and the
 *     masked keys are flagged; UNMASKED + formatted when permitted;
 *   - bank account is always masked tail-4;
 *   - missingRequired flags requested-but-empty fields (masked comp counts as
 *     present, not missing);
 *   - renderMerge substitutes only declared tokens and STRIPS unknown tokens
 *     (flags them, never echoes raw → XSS-safe).
 */

const { resolveMergeData, renderMerge, mergeFieldCatalog, MASK, _internals } = require('../mergeFields');

let passed = 0;
let failed = 0;
const discrepancies = [];

function check(scenario, cond, extra) {
  if (cond) { passed += 1; return; }
  failed += 1;
  discrepancies.push(scenario + (extra ? ` — ${extra}` : ''));
  console.error(`FAIL  ${scenario}${extra ? ` — ${extra}` : ''}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const EMP_IN = {
  firstName: 'Asha', lastName: 'Rao', code: 'EMP000142',
  designation: { name: 'Senior Engineer' }, department: { name: 'Engineering' },
  dateOfJoining: '2021-04-01', employmentType: 'FULL_TIME',
  email: 'asha@acme.test', phone: '+91 98765 43210',
  pan: 'ABCDE1234F', uan: '100200300400',
  bankName: 'HDFC Bank', bankAccount: '123456789012', ifsc: 'HDFC0001234',
};
const EMP_NZ = {
  firstName: 'Liam', lastName: 'Walker', code: 'EMP000200',
  designation: 'Support Lead', dateOfJoining: '2022-07-15',
  irdNumber: '123-456-789', taxCode: 'M', kiwiSaverRate: '3%',
  bankName: 'ANZ', bankAccount: '01-1234-5678901-00',
};
const BIZ_IN = {
  legalName: 'Acme Technologies Pvt Ltd', tradeName: 'Acme',
  addressBlock: '12 MG Road, Bengaluru', cin: 'U72200KA2015PTC012345', gstin: '29ABCDE1234F1Z5',
  signatoryName: 'Priya Sharma', signatoryDesignation: 'Head of HR',
};
const COMP = {
  ctcAnnual: 1850000, basic: 740000, hra: 296000, grossMonthly: 154166.67, netMonthly: 132500, specialAllowance: 250000,
};
const AUTH = { name: 'Priya Sharma', designation: 'Head of HR', subject: 'Re: Experience Certificate', purpose: 'visa', addressee: 'The Visa Officer' };
const NOW = new Date('2026-06-24T09:30:00Z');

// ── tests ────────────────────────────────────────────────────────────────────
function main() {
  // 1) en-IN resolve, WITH comp permission.
  const inRes = resolveMergeData({
    employee: EMP_IN, business: BIZ_IN, comp: COMP, entity: { countryCode: 'IN' },
    locale: 'en-IN', now: NOW, refNo: 'ACME/HR/2026/0001', authority: AUTH,
    perms: { canViewCompensation: true },
  });
  const v = inRes.values;
  check('IN employee.name joined', v['employee.name'] === 'Asha Rao', v['employee.name']);
  check('IN employee.designation from relation', v['employee.designation'] === 'Senior Engineer', v['employee.designation']);
  check('IN employee.department from relation', v['employee.department'] === 'Engineering', v['employee.department']);
  check('IN date.today dd/MM/yyyy', v['date.today'] === '24/06/2026', v['date.today']);
  check('IN employee.dateOfJoining dd/MM/yyyy', v['employee.dateOfJoining'] === '01/04/2021', v['employee.dateOfJoining']);
  check('IN comp.ctcAnnual ₹ + Indian grouping', v['comp.ctcAnnual'] === '₹18,50,000.00', v['comp.ctcAnnual']);
  check('IN comp.basic ₹ + grouping', v['comp.basic'] === '₹7,40,000.00', v['comp.basic']);
  check('IN comp NOT masked when permitted', inRes.masked.length === 0, `masked=${inRes.masked.join(',')}`);
  check('IN letter.refNo present', v['letter.refNo'] === 'ACME/HR/2026/0001', v['letter.refNo']);
  check('IN authority.name', v['authority.name'] === 'Priya Sharma', v['authority.name']);
  check('IN letter.subject from authority', v['letter.subject'] === 'Re: Experience Certificate', v['letter.subject']);
  check('IN company.legalName', v['company.legalName'] === 'Acme Technologies Pvt Ltd', v['company.legalName']);
  check('IN company.cin', v['company.cin'] === 'U72200KA2015PTC012345', v['company.cin']);
  check('IN employee.pan (IN statutory)', v['employee.pan'] === 'ABCDE1234F', v['employee.pan']);
  check('IN bank account masked tail-4', v['employee.bankAccountMasked'].endsWith('9012') && /[•]/.test(v['employee.bankAccountMasked']), v['employee.bankAccountMasked']);
  check('IN ifsc', v['employee.ifsc'] === 'HDFC0001234', v['employee.ifsc']);

  // 2) en-IN resolve, WITHOUT comp permission → masked + flagged.
  const masked = resolveMergeData({
    employee: EMP_IN, business: BIZ_IN, comp: COMP, locale: 'en-IN', now: NOW,
    perms: { canViewCompensation: false },
  });
  check('IN comp.ctcAnnual masked to ••••', masked.values['comp.ctcAnnual'] === MASK, masked.values['comp.ctcAnnual']);
  check('IN comp.basic masked to ••••', masked.values['comp.basic'] === MASK);
  check('IN comp.grossMonthly masked', masked.values['comp.grossMonthly'] === MASK);
  check('IN masked[] flags comp keys', masked.masked.includes('comp.ctcAnnual') && masked.masked.includes('comp.basic'), `masked=${masked.masked.join(',')}`);
  check('IN masked[] has all 7 comp fields', masked.masked.length === 7, `count=${masked.masked.length}`);
  check('IN non-comp fields still resolve when masked', masked.values['employee.name'] === 'Asha Rao');

  // 3) en-NZ locale → NZ$ + dd/MM/yyyy, NZ statutory ids.
  const nzRes = resolveMergeData({
    employee: EMP_NZ, business: { legalName: 'Kiwi Ops Ltd', nzbn: '9429000000000' },
    comp: { ctcAnnual: 95000, grossMonthly: 7916.67, netMonthly: 6200 },
    locale: 'en-NZ', now: NOW, perms: { canViewCompensation: true },
  });
  check('NZ comp.ctcAnnual NZ$ symbol', nzRes.values['comp.ctcAnnual'].startsWith('NZ$'), nzRes.values['comp.ctcAnnual']);
  check('NZ date.today dd/MM/yyyy', nzRes.values['date.today'] === '24/06/2026', nzRes.values['date.today']);
  check('NZ employee.irdNumber (NZ statutory)', nzRes.values['employee.irdNumber'] === '123-456-789', nzRes.values['employee.irdNumber']);
  check('NZ company.nzbn', nzRes.values['company.nzbn'] === '9429000000000', nzRes.values['company.nzbn']);
  check('NZ employee.taxCode', nzRes.values['employee.taxCode'] === 'M');

  // 4) missingRequired — requested-but-empty flagged; present (incl. masked) not.
  const missing = resolveMergeData({
    employee: { firstName: 'X' }, business: {}, comp: COMP, locale: 'en-IN', now: NOW,
    perms: { canViewCompensation: false },
    required: ['employee.name', 'employee.designation', 'comp.ctcAnnual', 'letter.refNo'],
  });
  check('missingRequired flags empty employee.designation', missing.missingRequired.includes('employee.designation'), missing.missingRequired.join(','));
  check('missingRequired flags empty letter.refNo', missing.missingRequired.includes('letter.refNo'));
  check('missingRequired does NOT flag present employee.name', !missing.missingRequired.includes('employee.name'));
  check('missingRequired does NOT flag MASKED comp.ctcAnnual (hidden ≠ missing)', !missing.missingRequired.includes('comp.ctcAnnual'), missing.missingRequired.join(','));

  // 4b) unknown required key is reported as missing.
  const unkReq = resolveMergeData({ employee: EMP_IN, business: BIZ_IN, locale: 'en-IN', now: NOW, perms: {}, required: ['employee.bogusField'] });
  check('missingRequired flags unknown required key', unkReq.missingRequired.includes('employee.bogusField'));

  // 5) renderMerge substitutes declared tokens, strips unknown ones.
  const body = 'Dear {{employee.name}}, your ref is {{letter.refNo}} dated {{date.today}}. CTC {{comp.ctcAnnual}}.';
  const r = renderMerge(body, inRes.values);
  check('renderMerge substitutes employee.name', r.text.includes('Asha Rao'), r.text);
  check('renderMerge substitutes letter.refNo', r.text.includes('ACME/HR/2026/0001'));
  check('renderMerge substitutes date.today', r.text.includes('24/06/2026'));
  check('renderMerge substitutes comp (permitted)', r.text.includes('₹18,50,000.00'));
  check('renderMerge no leftover braces', !/\{\{|\}\}/.test(r.text), r.text);
  check('renderMerge no unknown tokens for valid body', r.unknownTokens.length === 0);

  // 6) XSS-safety: unknown / undeclared token is FLAGGED and STRIPPED (never echoed).
  const evil = 'Hello {{employee.name}} {{evil.payload}} {{script.tag}} done.';
  const er = renderMerge(evil, inRes.values);
  check('renderMerge flags unknown evil.payload', er.unknownTokens.includes('evil.payload'), er.unknownTokens.join(','));
  check('renderMerge flags unknown script.tag', er.unknownTokens.includes('script.tag'));
  check('renderMerge STRIPS unknown token (not echoed raw)', !er.text.includes('evil.payload') && !er.text.includes('{{'), er.text);
  check('renderMerge keeps known token', er.text.includes('Asha Rao'));

  // 6b) A token that LOOKS like a tag but is malformed (no dot) is left as text,
  //     not treated as a token (we only match {{ns.field}}).
  const weird = renderMerge('safe {{nodot}} {{<script>}} text', inRes.values);
  check('renderMerge ignores malformed {{nodot}} (left as literal)', weird.text.includes('{{nodot}}'), weird.text);
  check('renderMerge ignores {{<script>}} (not a valid token shape)', weird.text.includes('{{<script>}}'));
  check('renderMerge does not flag malformed shapes as unknown tokens', weird.unknownTokens.length === 0, weird.unknownTokens.join(','));

  // 7) catalog palette filters by country.
  const inCat = mergeFieldCatalog({ country: 'IN' });
  const nzCat = mergeFieldCatalog({ country: 'NZ' });
  check('catalog IN includes employee.pan', !!inCat['employee.pan']);
  check('catalog IN excludes NZ-only employee.irdNumber', !nzCat['employee.pan'] === false || !inCat['employee.irdNumber'], 'IN excludes irdNumber');
  check('catalog IN excludes irdNumber', inCat['employee.irdNumber'] === undefined);
  check('catalog NZ includes irdNumber', !!nzCat['employee.irdNumber']);
  check('catalog NZ excludes pan', nzCat['employee.pan'] === undefined);
  check('catalog comp.ctcAnnual gatedBy canViewCompensation', inCat['comp.ctcAnnual'] && inCat['comp.ctcAnnual'].gatedBy === 'canViewCompensation');

  // 8) formatter internals.
  check('formatMoney IN ₹ grouping', _internals.formatMoney(1850000, 'en-IN') === '₹18,50,000.00', _internals.formatMoney(1850000, 'en-IN'));
  check('formatMoney NZ NZ$', _internals.formatMoney(95000, 'en-NZ') === 'NZ$95,000.00', _internals.formatMoney(95000, 'en-NZ'));
  check('formatMoney garbage → empty', _internals.formatMoney('xyz', 'en-IN') === '');
  check('formatDate ISO → dd/MM/yyyy', _internals.formatDate('2021-04-01', 'en-IN') === '01/04/2021');
  check('formatDate empty → empty', _internals.formatDate(null, 'en-IN') === '');
  check('maskAccount tail-4', /^•+9012$/.test(_internals.maskAccount('123456789012')), _internals.maskAccount('123456789012'));
  check('maskAccount empty → empty', _internals.maskAccount('') === '');

  // 9) defensive: no args at all does not throw and returns a values object.
  let safe = null;
  try { safe = resolveMergeData(); } catch (e) { discrepancies.push(`resolveMergeData() threw: ${e.message}`); failed += 1; }
  check('resolveMergeData() no-args returns values object', safe && typeof safe.values === 'object');
  check('renderMerge() defensive on empty body', renderMerge('', {}).text === '');
  check('renderMerge() defensive on null body', renderMerge(null, {}).text === '');

  // ── report ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(`mergeFields test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed > 0) {
    console.log('Discrepancies:');
    for (const d of discrepancies) console.log('  - ' + d);
    process.exitCode = 1;
  }
}

main();
