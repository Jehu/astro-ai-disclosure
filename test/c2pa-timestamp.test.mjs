import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readC2paManifest, isoGeneralizedTime, rfc3161GenTime } from '../dist/c2pa.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('createdAt falls back to the RFC 3161 signature timestamp', () => {
  // Google manifest: the `c2pa.created` action has no `when`, but the COSE
  // signature carries a sigTst2 TimeStampToken.
  const info = readC2paManifest(fixture('c2pa-timestamp.jpg'));
  assert.equal(info?.createdAt, '2026-09-24T08:53:46.000Z');
});

test('isoGeneralizedTime accepts RFC 3161 forms', () => {
  assert.equal(isoGeneralizedTime('20260924085346Z'), '2026-09-24T08:53:46.000Z');
  // Fractional seconds: truncated to milliseconds, padded to three digits.
  assert.equal(isoGeneralizedTime('20260924085346.5Z'), '2026-09-24T08:53:46.500Z');
  assert.equal(isoGeneralizedTime('20260924085346.123456Z'), '2026-09-24T08:53:46.123Z');
});

test('isoGeneralizedTime rejects non-RFC 3161 forms', () => {
  // Zone offsets are legal GeneralizedTime but not produced by RFC 3161 TSAs.
  assert.equal(isoGeneralizedTime('20260924085346+0100'), undefined);
  assert.equal(isoGeneralizedTime('20260924085346-0500'), undefined);
  assert.equal(isoGeneralizedTime('20260924085346'), undefined);
  assert.equal(isoGeneralizedTime('2026092408534Z'), undefined); // missing seconds
  assert.equal(isoGeneralizedTime('20261332259999Z'), undefined); // no month 13
  assert.equal(isoGeneralizedTime('20260231235959Z'), undefined); // no Feb 31
  assert.equal(isoGeneralizedTime(20260924), undefined);
  assert.equal(isoGeneralizedTime(null), undefined);
});

/** DER TLV: tag, definite length (short or long form), then content. */
function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let length;
  if (body.length < 0x80) length = Buffer.from([body.length]);
  else if (body.length <= 0xff) length = Buffer.from([0x81, body.length]);
  else length = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const explicit = (index, part) => tlv(0xa0 + index, part);
const integer = (n) => tlv(0x02, Buffer.from([n]));
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const genTimeTlv = (text) => tlv(0x18, Buffer.from(text, 'latin1'));

const OID_SIGNED_DATA = '06092a864886f70d010702'; // 1.2.840.113549.1.7.2
const OID_TST_INFO = '06092a864886f70d010704'; // 1.2.840.113549.1.7.4

/** Minimal RFC 3161 TimeStampToken: ContentInfo > [0] SignedData > eContent > TSTInfo. */
function timeStampToken(genTimeText, { genTimeTag = 0x18 } = {}) {
  const tstInfo = seq(
    integer(1), // version
    oid(OID_TST_INFO), // policy
    seq(integer(2)), // messageImprint
    integer(3), // serialNumber
    tlv(genTimeTag, Buffer.from(genTimeText, 'latin1')), // genTime
  );
  const signedData = seq(
    integer(1), // version
    set(), // digestAlgorithms
    seq(oid(OID_TST_INFO), explicit(0, tlv(0x04, tstInfo))), // encapContentInfo
  );
  return seq(oid(OID_SIGNED_DATA), explicit(0, signedData));
}

test('rfc3161GenTime reads genTime from a well-formed token', () => {
  assert.equal(rfc3161GenTime(timeStampToken('20260924085346Z')), '2026-09-24T08:53:46.000Z');
  assert.equal(rfc3161GenTime(timeStampToken('20260924085346.25Z')), '2026-09-24T08:53:46.250Z');
});

test('rfc3161GenTime rejects malformed tokens without throwing', () => {
  const token = timeStampToken('20260924085346Z');
  assert.equal(rfc3161GenTime(token.subarray(0, token.length - 1)), undefined); // truncated
  assert.equal(rfc3161GenTime(Buffer.from([0x30, 0x80, 0x00])), undefined); // indefinite length
  assert.equal(rfc3161GenTime(Buffer.from([0x30, 0x85, 0x01, 0x02])), undefined); // length-count > 4
  assert.equal(rfc3161GenTime(Buffer.from([0x30, 0x04])), undefined); // length beyond input
  assert.equal(rfc3161GenTime(new Uint8Array(0)), undefined);
  assert.equal(rfc3161GenTime(Buffer.from('not der at all')), undefined);
  assert.equal(rfc3161GenTime(timeStampToken('20260924085346Z', { genTimeTag: 0x16 })), undefined); // genTime not GeneralizedTime
});
