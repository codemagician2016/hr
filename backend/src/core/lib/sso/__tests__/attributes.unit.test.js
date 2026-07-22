'use strict';

/*
 * attributes.unit.test.js — SSO claim/attribute extraction (pure; NO DB):
 * OIDC claims object → identity, SAML profile → identity, attributeMap
 * overrides, and pickTarget dispatch.
 *   node backend/src/core/lib/sso/__tests__/attributes.unit.test.js
 */

const assert = require('assert');
const {
  extractOidcIdentity, extractSamlIdentity, pickTarget, SsoError,
} = require('../attributes');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }
function eq(name, a, b) { assert.deepStrictEqual(a, b, `${name} (got ${JSON.stringify(a)})`); passed += 1; }
function catching(fn) { try { fn(); return null; } catch (e) { return e; } }

function main() {
  /* ══ OIDC ═══════════════════════════════════════════════════════ */
  {
    // a realistic Azure AD / Okta id_token claim set
    const claims = {
      sub: '00u1abcd',
      email: 'Jane.Doe@Acme.COM',
      email_verified: true,
      name: 'Jane Doe',
      given_name: 'Jane',
      family_name: 'Doe',
      iss: 'https://idp.example.com',
      aud: 'client-1',
    };
    const id = extractOidcIdentity(claims, null);
    eq('oidc happy path', id, {
      subject: '00u1abcd',
      email: 'jane.doe@acme.com',
      emailVerified: true,
      name: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe',
    });
  }
  {
    // Azure often has NO email claim — preferred_username / upn carry it
    const id = extractOidcIdentity({ sub: 's1', preferred_username: 'jd@acme.com' }, null);
    ok('preferred_username fallback', id.email === 'jd@acme.com');
    const id2 = extractOidcIdentity({ sub: 's1', upn: 'UPN@acme.com' }, null);
    ok('upn fallback', id2.email === 'upn@acme.com');
  }
  {
    // name derived from given/family, then from email local part
    const id = extractOidcIdentity({ sub: 's', email: 'a@b.c', given_name: 'A', family_name: 'B' }, null);
    ok('name from parts', id.name === 'A B');
    const id2 = extractOidcIdentity({ sub: 's', email: 'solo@b.c' }, null);
    ok('name from email local part', id2.name === 'solo');
  }
  {
    // attributeMap overrides win over standard claims
    const claims = {
      sub: 's', email: 'wrong@acme.com', mail_real: 'right@acme.com', displayLabel: 'Right Name',
    };
    const id = extractOidcIdentity(claims, { email: 'mail_real', name: 'displayLabel' });
    ok('attributeMap email override', id.email === 'right@acme.com');
    ok('attributeMap name override', id.name === 'Right Name');
  }
  {
    ok('email_verified false surfaces', extractOidcIdentity({ sub: 's', email: 'a@b.c', email_verified: false }, null).emailVerified === false);
    ok('email_verified absent defaults true', extractOidcIdentity({ sub: 's', email: 'a@b.c' }, null).emailVerified === true);
  }
  {
    const e = catching(() => extractOidcIdentity({ email: 'a@b.c' }, null));
    ok('no sub → SsoError no-subject', e instanceof SsoError && e.code === 'no-subject' && e.status === 401);
    const e2 = catching(() => extractOidcIdentity({ sub: 's', name: 'No Email' }, null));
    ok('no email → SsoError no-email', e2 instanceof SsoError && e2.code === 'no-email' && e2.status === 400);
    const e3 = catching(() => extractOidcIdentity({ sub: 's', email: 'not-an-email' }, null));
    ok('malformed email rejected', e3 instanceof SsoError && e3.code === 'no-email');
  }

  /* ══ SAML ═══════════════════════════════════════════════════════ */
  {
    // Okta-style profile: email NameID + friendly attribute names
    const profile = {
      nameID: 'jane.doe@acme.com',
      nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      email: 'Jane.Doe@Acme.com',
      firstName: 'Jane',
      lastName: 'Doe',
    };
    const id = extractSamlIdentity(profile, null);
    ok('saml subject = nameID', id.subject === 'jane.doe@acme.com');
    ok('saml email lowercased', id.email === 'jane.doe@acme.com');
    ok('saml first/last', id.firstName === 'Jane' && id.lastName === 'Doe');
    ok('saml assertion emails are trusted', id.emailVerified === true);
  }
  {
    // Azure AD-style: URI claim names
    const profile = {
      nameID: 'azure-sub-1',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'ms@acme.com',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Emm',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'Ess',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'Emm Ess',
    };
    const id = extractSamlIdentity(profile, null);
    ok('azure URI email attr', id.email === 'ms@acme.com');
    ok('azure URI name attr', id.name === 'Emm Ess');
    ok('azure URI given/surname', id.firstName === 'Emm' && id.lastName === 'Ess');
  }
  {
    // email-format NameID alone is enough (the most common minimal setup)
    const id = extractSamlIdentity({ nameID: 'Only.NameId@Acme.com' }, null);
    ok('email NameID fallback', id.email === 'only.nameid@acme.com');
    ok('name falls back to local part', id.name === 'only.nameid');
  }
  {
    // array-valued attributes (multi-valued assertions) take the first value
    const id = extractSamlIdentity({ nameID: 'n1', mail: ['multi@acme.com', 'second@acme.com'] }, null);
    ok('array attribute takes first', id.email === 'multi@acme.com');
  }
  {
    // attributeMap override
    const id = extractSamlIdentity(
      { nameID: 'n1', weirdEmailAttr: 'mapped@acme.com' },
      { email: 'weirdEmailAttr' },
    );
    ok('saml attributeMap email override', id.email === 'mapped@acme.com');
  }
  {
    const e = catching(() => extractSamlIdentity({}, null));
    ok('no nameID → no-subject', e instanceof SsoError && e.code === 'no-subject');
    const e2 = catching(() => extractSamlIdentity({ nameID: 'opaque-id-123' }, null));
    ok('opaque NameID + no email attr → no-email', e2 instanceof SsoError && e2.code === 'no-email');
  }

  /* ══ pickTarget ═════════════════════════════════════════════════ */
  {
    ok('ESS conn default', pickTarget({ loginTarget: 'ESS' }, null) === 'ESS');
    ok('OPERATOR conn default', pickTarget({ loginTarget: 'OPERATOR' }, null) === 'OPERATOR');
    ok('BOTH defaults to ESS', pickTarget({ loginTarget: 'BOTH' }, null) === 'ESS');
    ok('BOTH honours ?target=operator', pickTarget({ loginTarget: 'BOTH' }, 'operator') === 'OPERATOR');
    ok('missing loginTarget defaults ESS', pickTarget({}, null) === 'ESS');
    const e = catching(() => pickTarget({ loginTarget: 'ESS' }, 'OPERATOR'));
    ok('ESS-only conn refuses operator', e instanceof SsoError && e.code === 'target-not-allowed' && e.status === 403);
    const e2 = catching(() => pickTarget({ loginTarget: 'BOTH' }, 'bogus'));
    ok('unknown target rejected', e2 instanceof SsoError && e2.code === 'bad-target');
  }

  console.log(`attributes.unit.test.js — ${passed} assertions passed`);
}

main();
