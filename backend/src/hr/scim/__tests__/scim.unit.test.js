'use strict';

/*
 * scim.unit.test.js — SCIM 2.0 pure parts: the filter parser, the response
 * envelopes / Employee→User projection, and the PATCH Operations reducer.
 * Plain-node, NO DB (mirrors reports/__tests__ style):
 *   node backend/src/hr/scim/__tests__/scim.unit.test.js
 */

const assert = require('assert');
const { parseScimFilter, ScimFilterError } = require('../filter');
const { applyScimPatch, ScimPatchError, _internals } = require('../patch');
const {
  scimError, listResponse, employeeToScimUser, serviceProviderConfig, resourceTypes, schemasDoc, MAX_RESULTS,
} = require('../envelope');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }
function eq(name, a, b) { assert.deepStrictEqual(a, b, `${name} (got ${JSON.stringify(a)})`); passed += 1; }
function catching(fn) { try { fn(); return null; } catch (e) { return e; } }

function main() {
  /* ══ filter parser ══════════════════════════════════════════════ */
  {
    const f = parseScimFilter('userName eq "jane@acme.com"');
    eq('userName eq parses', f, {
      attribute: 'username', rawAttribute: 'userName', op: 'eq', value: 'jane@acme.com',
    });
  }
  {
    const f = parseScimFilter('externalId eq "00u1abcd"');
    ok('externalId attr normalised', f.attribute === 'externalid' && f.value === '00u1abcd');
  }
  {
    const f = parseScimFilter('active eq true');
    ok('boolean literal value', f.value === true);
    const f2 = parseScimFilter('active eq false');
    ok('false literal', f2.value === false);
  }
  {
    const f = parseScimFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "x@y.z"');
    ok('URN-prefixed attr strips to userName', f.attribute === 'username');
  }
  {
    const f = parseScimFilter('userName eq "O\'Brien \\"quoted\\"@acme.com"');
    ok('escaped quotes unescape', f.value === 'O\'Brien "quoted"@acme.com');
  }
  ok('empty filter → null', parseScimFilter('') === null && parseScimFilter(undefined) === null);
  {
    const e = catching(() => parseScimFilter('userName co "jane"'));
    ok('co operator rejected', e instanceof ScimFilterError && e.message.includes('co'));
  }
  {
    const e = catching(() => parseScimFilter('userName eq "a" and active eq true'));
    ok('compound filter rejected', e instanceof ScimFilterError);
  }
  {
    const e = catching(() => parseScimFilter('eq eq'));
    ok('garbage filter rejected', e instanceof ScimFilterError);
  }

  /* ══ envelopes ══════════════════════════════════════════════════ */
  {
    const err = scimError(404, 'User x not found');
    eq('error envelope shape', err, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '404',
      detail: 'User x not found',
    });
    const err2 = scimError(409, 'dup', 'uniqueness');
    ok('scimType carried', err2.scimType === 'uniqueness' && err2.status === '409');
  }
  {
    const lr = listResponse({ resources: [{ id: 'a' }], totalResults: 5, startIndex: 3, itemsPerPage: 1 });
    ok('list schema urn', lr.schemas[0] === 'urn:ietf:params:scim:api:messages:2.0:ListResponse');
    ok('list paging fields', lr.totalResults === 5 && lr.startIndex === 3 && lr.itemsPerPage === 1);
    ok('list Resources capital R', Array.isArray(lr.Resources) && lr.Resources.length === 1);
  }
  {
    const emp = {
      id: 'emp-1',
      externalId: 'okta-77',
      firstName: 'Jane',
      lastName: 'Doe',
      workEmail: 'jane@acme.com',
      personalEmail: 'jane.personal@gmail.com',
      isActive: true,
      createdAt: new Date('2026-01-02T03:04:05Z'),
      updatedAt: new Date('2026-06-07T08:09:10Z'),
    };
    const r = employeeToScimUser(emp, { baseUrl: 'https://api.x/scim/v2', title: 'Senior Engineer' });
    ok('User schema urn', r.schemas[0] === 'urn:ietf:params:scim:schemas:core:2.0:User');
    ok('id is employee id', r.id === 'emp-1');
    ok('userName = workEmail', r.userName === 'jane@acme.com');
    eq('name block', r.name, { givenName: 'Jane', familyName: 'Doe', formatted: 'Jane Doe' });
    ok('active true', r.active === true);
    ok('externalId carried', r.externalId === 'okta-77');
    ok('title carried', r.title === 'Senior Engineer');
    eq('emails: work primary + home', r.emails, [
      { value: 'jane@acme.com', type: 'work', primary: true },
      { value: 'jane.personal@gmail.com', type: 'home', primary: false },
    ]);
    ok('meta.resourceType', r.meta.resourceType === 'User');
    ok('meta.created iso', r.meta.created === '2026-01-02T03:04:05.000Z');
    ok('meta.lastModified iso', r.meta.lastModified === '2026-06-07T08:09:10.000Z');
    ok('meta.location', r.meta.location === 'https://api.x/scim/v2/Users/emp-1');
  }
  {
    // placeholder lastName '-' (bridge default) must not leak into the payload
    const r = employeeToScimUser({
      id: 'e2', firstName: 'Solo', lastName: '-', workEmail: 's@a.co', isActive: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    ok('placeholder familyName omitted', r.name.familyName === undefined);
    ok('inactive employee → active:false', r.active === false);
  }
  {
    const w = ['warning one.'];
    const r = employeeToScimUser({
      id: 'e3', firstName: 'A', lastName: 'B', workEmail: 'a@b.c', isActive: true,
      createdAt: new Date(), updatedAt: new Date(),
    }, { warnings: w });
    ok('warnings ride vendor urn', r['urn:drifthr:params:scim:warnings'][0] === 'warning one.');
    ok('warnings joined into detail', r.detail === 'warning one.');
  }
  {
    const spc = serviceProviderConfig('https://api.x/scim/v2');
    ok('SPC patch supported', spc.patch.supported === true);
    ok('SPC filter supported + maxResults', spc.filter.supported === true && spc.filter.maxResults === MAX_RESULTS && MAX_RESULTS === 200);
    ok('SPC bulk unsupported', spc.bulk.supported === false);
    const rt = resourceTypes('https://api.x/scim/v2');
    ok('ResourceTypes lists User', rt.Resources[0].id === 'User' && rt.Resources[0].endpoint === '/Users');
    const sch = schemasDoc('https://api.x/scim/v2');
    ok('Schemas doc carries core User', sch.Resources[0].id === 'urn:ietf:params:scim:schemas:core:2.0:User');
    const attrs = sch.Resources[0].attributes.map((a) => a.name);
    for (const a of ['userName', 'name', 'active', 'title', 'externalId', 'emails']) {
      ok(`schema attr ${a}`, attrs.includes(a));
    }
  }

  /* ══ PATCH Operations reducer ═══════════════════════════════════ */
  {
    // Okta shape: real booleans + dotted paths
    const { changes, unsupported } = applyScimPatch([
      { op: 'replace', path: 'active', value: false },
      { op: 'replace', path: 'name.givenName', value: 'Janet' },
      { op: 'replace', path: 'title', value: 'Staff Engineer' },
    ]);
    eq('okta replace set', changes, { active: false, givenName: 'Janet', title: 'Staff Engineer' });
    ok('nothing unsupported', unsupported.length === 0);
  }
  {
    // Azure AD shape: capitalised op + boolean-as-string
    const { changes } = applyScimPatch([{ op: 'Replace', path: 'active', value: 'False' }]);
    ok('azure "False" string coerces', changes.active === false);
    const { changes: c2 } = applyScimPatch([{ op: 'Add', path: 'active', value: 'True' }]);
    ok('azure "True" via Add coerces', c2.active === true);
  }
  {
    // Azure no-path operation: object value fans out
    const { changes } = applyScimPatch([{
      op: 'replace',
      value: { active: true, userName: 'NEW@Acme.com', name: { givenName: 'N', familyName: 'U' }, title: 'CTO' },
    }]);
    eq('no-path object fans out', changes, {
      active: true, userName: 'new@acme.com', givenName: 'N', familyName: 'U', title: 'CTO',
    });
  }
  {
    // emails with a value filter path
    const { changes } = applyScimPatch([
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'Work@Acme.com' },
    ]);
    ok('emails filter path → email', changes.email === 'work@acme.com');
  }
  {
    // emails array replace picks primary
    const { changes } = applyScimPatch([{
      op: 'replace',
      path: 'emails',
      value: [
        { value: 'other@acme.com', type: 'home' },
        { value: 'prim@acme.com', type: 'work', primary: true },
      ],
    }]);
    ok('emails array picks primary', changes.email === 'prim@acme.com');
  }
  {
    const { changes } = applyScimPatch([{ op: 'remove', path: 'title' }]);
    ok('remove title → null', changes.title === null);
    const { changes: c2 } = applyScimPatch([{ op: 'replace', path: 'externalId', value: 'x1' }]);
    ok('externalId set', c2.externalId === 'x1');
  }
  {
    const { changes, unsupported } = applyScimPatch([
      { op: 'replace', path: 'phoneNumbers[type eq "work"].value', value: '+64...' },
      { op: 'replace', path: 'active', value: true },
    ]);
    ok('unknown path tolerated (collected)', unsupported.length === 1 && changes.active === true);
  }
  {
    const e = catching(() => applyScimPatch([]));
    ok('empty Operations rejects', e instanceof ScimPatchError);
    const e2 = catching(() => applyScimPatch([{ op: 'move', path: 'active', value: 1 }]));
    ok('unknown op rejects', e2 instanceof ScimPatchError);
    const e3 = catching(() => applyScimPatch([{ op: 'replace', path: 'active', value: 'maybe' }]));
    ok('non-boolean active rejects', e3 instanceof ScimPatchError);
    const e4 = catching(() => applyScimPatch([{ op: 'remove' }]));
    ok('remove without path rejects', e4 instanceof ScimPatchError);
  }
  {
    // URN-prefixed patch path (Azure sends these for the core schema)
    const { changes } = applyScimPatch([{
      op: 'replace', path: 'urn:ietf:params:scim:schemas:core:2.0:User:userName', value: 'Via@Urn.com',
    }]);
    ok('URN-prefixed path resolves', changes.userName === 'via@urn.com');
  }
  {
    // internals sanity
    ok('coerceBool passthrough', _internals.coerceBool(true) === true && _internals.coerceBool('FALSE') === false && _internals.coerceBool('x') === null);
    ok('primaryEmail from strings', _internals.primaryEmail(['A@b.C']) === 'a@b.c');
  }

  console.log(`scim.unit.test.js — ${passed} assertions passed`);
}

main();
