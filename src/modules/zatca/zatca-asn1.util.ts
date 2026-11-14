import * as crypto from 'crypto';

/**
 * Just enough DER to build the certificate request ZATCA asks for and to read the two things the
 * phase-2 QR needs from the certificate it returns, with Node's own crypto and no extra package.
 */

const length = (size: number) => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

export const der = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
export const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items));
export const integer = (value: number) => der(0x02, Buffer.from([value]));
export const octetString = (content: Buffer) => der(0x04, content);
export const bitString = (content: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), content]));
export const utf8String = (text: string) => der(0x0c, Buffer.from(text, 'utf8'));
export const printableString = (text: string) => der(0x13, Buffer.from(text, 'ascii'));

export function oid(dotted: string) {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

const OID = {
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  country: '2.5.4.6',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  title: '2.5.4.12',
  businessCategory: '2.5.4.15',
  registeredAddress: '2.5.4.26',
  uid: '0.9.2342.19200300.100.1.1',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  certificateTemplateName: '1.3.6.1.4.1.311.20.2',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
};

/** One attribute per RDN, the way OpenSSL writes a ZATCA config. */
const name = (pairs: [string, Buffer][]) => sequence(...pairs.map(([type, value]) => set(sequence(oid(type), value))));

export type CsrFields = {
  /** Common name, e.g. TST-886431145-399999999900003. */
  commonName: string;
  /** Branch or unit name; for a VAT group the 10-digit TIN. */
  organizationUnit: string;
  organization: string;
  /** "1-<solution>|2-<model>|3-<serial>" identifying this installation. */
  serialNumber: string;
  vatNumber: string;
  /** Four flags: standard, simplified, future, future. Simplified only is 0100. */
  invoiceType: string;
  /** Short address of the branch. */
  location: string;
  industry: string;
  /** ZATCA-Code-Signing, PREZATCA-Code-Signing or TSTZATCA-Code-Signing depending on the environment. */
  template: string;
};

/** A PKCS#10 request signed with ECDSA-SHA256, as PEM text. */
export function buildCsr(fields: CsrFields, privateKey: crypto.KeyObject) {
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const subject = name([
    [OID.commonName, utf8String(fields.commonName)],
    [OID.organizationalUnit, utf8String(fields.organizationUnit)],
    [OID.organization, utf8String(fields.organization)],
    [OID.country, printableString('SA')],
  ]);
  const directory = name([
    [OID.surname, utf8String(fields.serialNumber)],
    [OID.uid, utf8String(fields.vatNumber)],
    [OID.title, utf8String(fields.invoiceType)],
    [OID.registeredAddress, utf8String(fields.location)],
    [OID.businessCategory, utf8String(fields.industry)],
  ]);
  const extensions = sequence(
    sequence(oid(OID.certificateTemplateName), octetString(printableString(fields.template))),
    // GeneralNames holding one directoryName ([4], explicit because Name is a CHOICE).
    sequence(oid(OID.subjectAltName), octetString(sequence(der(0xa4, directory)))),
  );
  const attributes = der(0xa0, sequence(oid(OID.extensionRequest), set(extensions)));
  const info = sequence(integer(0), subject, publicKey, attributes);
  const signature = crypto.sign('sha256', info, privateKey);
  const request = sequence(info, sequence(oid(OID.ecdsaWithSha256)), bitString(signature));
  const body = request.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN CERTIFICATE REQUEST-----\n${body}\n-----END CERTIFICATE REQUEST-----\n`;
}

type Node = { tag: number; start: number; contentStart: number; end: number };

/** Reads one TLV at an offset. */
export function readNode(buffer: Buffer, offset: number): Node {
  const tag = buffer[offset];
  let size = buffer[offset + 1];
  let contentStart = offset + 2;
  if (size & 0x80) {
    const count = size & 0x7f;
    size = 0;
    for (let index = 0; index < count; index++) size = size * 256 + buffer[offset + 2 + index];
    contentStart += count;
  }
  return { tag, start: offset, contentStart, end: contentStart + size };
}

const children = (buffer: Buffer, parent: Node) => {
  const nodes: Node[] = [];
  for (let offset = parent.contentStart; offset < parent.end; ) {
    const node = readNode(buffer, offset);
    nodes.push(node);
    offset = node.end;
  }
  return nodes;
};

/** The certificate as ZATCA returns it: base64 of the base64 body. Returns the body (one base64 line). */
export const certificateBody = (binarySecurityToken: string) => Buffer.from(binarySecurityToken, 'base64').toString('utf8').replace(/-----[^-]+-----|\s/g, '');

export const certificatePem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body.replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----\n`;

export type CertificateInfo = {
  /** Base64 of the hex SHA-256 of the certificate body, as ZATCA's own SDK writes it. */
  hash: string;
  /** "CN=..., DC=..." in the order ZATCA's samples print. */
  issuer: string;
  serialNumber: string;
  /** SubjectPublicKeyInfo DER, QR tag 8. */
  publicKey: Buffer;
  /** The issuer's signature over the certificate, QR tag 9. */
  signature: Buffer;
};

export function certificateInfo(body: string): CertificateInfo {
  const raw = Buffer.from(body, 'base64');
  const cert = new crypto.X509Certificate(raw);
  const top = readNode(raw, 0);
  const [, , signatureValue] = children(raw, top);
  return {
    hash: Buffer.from(crypto.createHash('sha256').update(body, 'utf8').digest('hex')).toString('base64'),
    issuer: cert.issuer.split('\n').filter(Boolean).reverse().join(', '),
    serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
    publicKey: cert.publicKey.export({ type: 'spki', format: 'der' }),
    // The BIT STRING's first byte counts unused bits, always 0 here.
    signature: raw.subarray(signatureValue.contentStart + 1, signatureValue.end),
  };
}
