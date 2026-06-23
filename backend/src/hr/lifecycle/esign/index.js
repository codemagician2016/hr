'use strict';

/**
 * esign/index.js — wires the BUILTIN provider into the provider registry
 * (Feature 4 §3.2, §4.4, slice 4d). v1 registers BUILTIN only; vendor adapters
 * (DocuSign / Zoho / Adobe / Digio / Leegality) register here in a later additive
 * pass against the same SignatureEnvelope / SignatureSigner tables.
 */

const provider = require('./provider');
const builtin = require('./builtin');

provider.register('BUILTIN', builtin);

module.exports = { ...provider, builtin };
