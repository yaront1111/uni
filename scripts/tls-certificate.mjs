import {generateKeyPairSync, randomBytes, sign} from 'node:crypto';

/** Self-signed loopback TLS material for the disposable test harnesses.
 * Generated in process so the suite needs no certificate tool on PATH; a missing
 * `openssl` must never look like a product failure. Test-only: one day of
 * validity, loopback names, and the private key never leaves the harness. */
function length(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let value = size; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, ...values) {
  const value = Buffer.concat(values);
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}
const sequence = (...values) => tlv(0x30, ...values);
const set = (...values) => tlv(0x31, ...values);
const explicit = (number, ...values) => tlv(0xa0 | number, ...values);
const octetString = (...values) => tlv(0x04, ...values);
const bitString = value => tlv(0x03, Buffer.from([0]), value);
const boolean = value => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = value => tlv(0x0c, Buffer.from(value, 'utf8'));
const integer = value => tlv(0x02, value);
/** DER integers are minimal: a leading zero byte is legal only before a set high bit. */
function positiveInteger(bytes) {
  let start = 0;
  while (start + 1 < bytes.length && bytes[start] === 0 && bytes[start + 1] < 0x80) start += 1;
  const trimmed = bytes.subarray(start);
  return integer(trimmed[0] >= 0x80 ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed);
}
function objectIdentifier(notation) {
  const parts = notation.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const base128 = [part & 0x7f];
    for (let value = part >>> 7; value > 0; value >>>= 7) base128.unshift((value & 0x7f) | 0x80);
    bytes.push(...base128);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function utcTime(date) {
  // UTCTime is YYMMDDHHMMSSZ.
  const text = date.toISOString().replace(/[-:T]/g, '').replace(/^\d\d/, '').replace(/\.\d+Z$/, 'Z');
  return tlv(0x17, Buffer.from(text, 'ascii'));
}
function extension(notation, critical, value) {
  return sequence(objectIdentifier(notation), ...(critical ? [boolean(true)] : []), octetString(value));
}

export function createSelfSignedCertificate() {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const algorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = sequence(set(sequence(objectIdentifier('2.5.4.3'), utf8String('localhost'))));
  const serial = positiveInteger(Buffer.concat([Buffer.from([0x00]), randomBytes(16)]));
  const now = Date.now();
  const tbs = sequence(
    explicit(0, integer(Buffer.from([0x02]))), // X.509 v3
    serial,
    algorithm,
    name,
    sequence(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({format: 'der', type: 'spki'}),
    explicit(3, sequence(
      extension('2.5.29.19', true, sequence(boolean(true))), // basicConstraints CA:TRUE
      extension('2.5.29.17', false, sequence( // subjectAltName DNS:localhost, IP:127.0.0.1
        tlv(0x82, Buffer.from('localhost', 'ascii')),
        tlv(0x87, Buffer.from([127, 0, 0, 1])))),
    )),
  );
  const certificate = sequence(tbs, algorithm, bitString(sign('sha256', tbs, privateKey)));
  const pem = text => text.match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({format: 'pem', type: 'pkcs8'}),
    certificate: '-----BEGIN CERTIFICATE-----\n' + pem(certificate.toString('base64')) + '\n-----END CERTIFICATE-----\n',
  };
}
