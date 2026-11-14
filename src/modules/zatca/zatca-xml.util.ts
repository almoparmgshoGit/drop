import * as crypto from 'crypto';
import { CertificateInfo } from './zatca-asn1.util';

/**
 * ZATCA phase 2 (integration) documents: UBL 2.1 simplified tax invoices and their credit notes,
 * hashed, signed with XAdES and carrying the phase-2 QR.
 *
 * The XML is written already in canonical form (C14N 1.1): no declaration inside the hashed part,
 * no whitespace between elements, every element closed with an end tag, namespace declarations
 * first and attributes in order, and canonical escaping. Since we build every byte ourselves,
 * canonicalizing the document is the identity, and removing UBLExtensions, cac:Signature and the
 * QR reference (the transforms ZATCA applies) leaves exactly the "pure" string we hash. Nothing
 * is pretty-printed after signing, because whitespace would change what ZATCA hashes.
 */

export const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  sig: 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
  sac: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
  sbc: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  xades: 'http://uri.etsi.org/01903/v1.3.2#',
};

const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const C14N11 = 'http://www.w3.org/2006/12/xml-c14n11';
const XPATH = 'http://www.w3.org/TR/1999/REC-xpath-19991116';

/** The PIH of the very first document: base64 of the hex SHA-256 of "0", as ZATCA publishes it. */
export const FIRST_PREVIOUS_HASH = Buffer.from(crypto.createHash('sha256').update('0').digest('hex')).toString('base64');

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escapeAttr = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

type Attrs = Record<string, string | undefined>;

/** Namespace declarations first (default, then by prefix), then the plain attributes by name, as C14N orders them. */
const attrString = (attrs: Attrs = {}) => {
  const entries = Object.entries(attrs).filter(([, value]) => value !== undefined) as [string, string][];
  const rank = ([key]: [string, string]) => (key === 'xmlns' ? `0` : key.startsWith('xmlns:') ? `1${key}` : `2${key}`);
  return entries
    .sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('');
};

/** An element with child elements; falsy children are skipped. */
export const el = (tag: string, attrs: Attrs | null, ...children: (string | false | null | undefined)[]) =>
  `<${tag}${attrString(attrs ?? {})}>${children.filter(Boolean).join('')}</${tag}>`;
/** An element holding text. */
export const tx = (tag: string, text: string, attrs?: Attrs) => `<${tag}${attrString(attrs)}>${escapeText(text)}</${tag}>`;

const money = (halalas: number) => (halalas / 100).toFixed(2);
const SAR = { currencyID: 'SAR' };

export type ZatcaSeller = {
  name: string;
  vatNumber: string;
  crNumber: string;
  street: string;
  building: string;
  additionalNumber?: string;
  district: string;
  city: string;
  postalCode: string;
};

export type ZatcaDocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export type ZatcaDocumentInput = {
  kind: ZatcaDocumentKind;
  /** The number printed on the paper, e.g. INV-T12-0042. */
  number: string;
  uuid: string;
  icv: number;
  previousHash: string;
  issuedAt: Date;
  seller: ZatcaSeller;
  buyerName?: string | null;
  /** Amounts in halalas, net of VAT; vat is the VAT on that line. */
  lines: { name: string; net: number; vat: number }[];
  vatRate: number;
  /** For credit and debit notes: the invoice they adjust. */
  billingReference?: string;
  /** For credit and debit notes the reason is mandatory (KSA-10). */
  reason?: string | null;
  /** UNTDID 4461: 10 cash, 30 transfer, 48 card, 1 not defined. */
  paymentMeansCode?: string;
};

const TYPE_CODE: Record<ZatcaDocumentKind, string> = { INVOICE: '388', CREDIT_NOTE: '381', DEBIT_NOTE: '383' };
/** Simplified tax invoice: 02 then five flags (third party, nominal, export, summary, self-billed). */
const SIMPLIFIED = '0200000';

/** Issue date and time in Riyadh, the way they appear in the XML and in QR tag 3. */
export const riyadhDateTime = (date: Date) => {
  const iso = new Date(date.getTime() + 3 * 3600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
};

const taxCategory = (tag: 'cac:TaxCategory' | 'cac:ClassifiedTaxCategory', rate: number) =>
  rate > 0
    ? el(tag, null, tx('cbc:ID', 'S'), tx('cbc:Percent', rate.toFixed(2)), el('cac:TaxScheme', null, tx('cbc:ID', 'VAT')))
    : el(
        tag,
        null,
        tx('cbc:ID', 'O'),
        tx('cbc:Percent', '0.00'),
        tag === 'cac:TaxCategory' && tx('cbc:TaxExemptionReasonCode', 'VATEX-SA-OOS'),
        tag === 'cac:TaxCategory' && tx('cbc:TaxExemptionReason', 'Not subject to VAT'),
        el('cac:TaxScheme', null, tx('cbc:ID', 'VAT')),
      );

const ROOT_ATTRS = { xmlns: NS.invoice, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext };

/** The document in pieces, so the hashed form and the signed form are cut from the same strings. */
function documentParts(input: ZatcaDocumentInput) {
  const { date, time } = riyadhDateTime(input.issuedAt);
  const net = input.lines.reduce((sum, line) => sum + line.net, 0);
  const vat = input.lines.reduce((sum, line) => sum + line.vat, 0);
  const seller = input.seller;
  const isNote = input.kind !== 'INVOICE';

  const head = [
    tx('cbc:ProfileID', 'reporting:1.0'),
    tx('cbc:ID', input.number),
    tx('cbc:UUID', input.uuid),
    tx('cbc:IssueDate', date),
    tx('cbc:IssueTime', time),
    tx('cbc:InvoiceTypeCode', TYPE_CODE[input.kind], { name: SIMPLIFIED }),
    tx('cbc:DocumentCurrencyCode', 'SAR'),
    tx('cbc:TaxCurrencyCode', 'SAR'),
    isNote && input.billingReference && el('cac:BillingReference', null, el('cac:InvoiceDocumentReference', null, tx('cbc:ID', input.billingReference))),
    el('cac:AdditionalDocumentReference', null, tx('cbc:ID', 'ICV'), tx('cbc:UUID', String(input.icv))),
    el('cac:AdditionalDocumentReference', null, tx('cbc:ID', 'PIH'), el('cac:Attachment', null, tx('cbc:EmbeddedDocumentBinaryObject', input.previousHash, { mimeCode: 'text/plain' }))),
  ].filter(Boolean) as string[];

  const tail = [
    el(
      'cac:AccountingSupplierParty',
      null,
      el(
        'cac:Party',
        null,
        el('cac:PartyIdentification', null, tx('cbc:ID', seller.crNumber, { schemeID: 'CRN' })),
        el(
          'cac:PostalAddress',
          null,
          tx('cbc:StreetName', seller.street),
          tx('cbc:BuildingNumber', seller.building),
          seller.additionalNumber && tx('cbc:PlotIdentification', seller.additionalNumber),
          tx('cbc:CitySubdivisionName', seller.district),
          tx('cbc:CityName', seller.city),
          tx('cbc:PostalZone', seller.postalCode),
          el('cac:Country', null, tx('cbc:IdentificationCode', 'SA')),
        ),
        el('cac:PartyTaxScheme', null, tx('cbc:CompanyID', seller.vatNumber), el('cac:TaxScheme', null, tx('cbc:ID', 'VAT'))),
        el('cac:PartyLegalEntity', null, tx('cbc:RegistrationName', seller.name)),
      ),
    ),
    // A simplified invoice needs no buyer details; the passenger's name is kept when there is one.
    el('cac:AccountingCustomerParty', null, input.buyerName && el('cac:Party', null, el('cac:PartyLegalEntity', null, tx('cbc:RegistrationName', input.buyerName)))),
    (isNote || input.paymentMeansCode) &&
      el('cac:PaymentMeans', null, tx('cbc:PaymentMeansCode', input.paymentMeansCode || '10'), isNote && tx('cbc:InstructionNote', input.reason?.trim() || 'Refund')),
    el('cac:TaxTotal', null, tx('cbc:TaxAmount', money(vat), SAR)),
    el(
      'cac:TaxTotal',
      null,
      tx('cbc:TaxAmount', money(vat), SAR),
      el('cac:TaxSubtotal', null, tx('cbc:TaxableAmount', money(net), SAR), tx('cbc:TaxAmount', money(vat), SAR), taxCategory('cac:TaxCategory', input.vatRate)),
    ),
    el(
      'cac:LegalMonetaryTotal',
      null,
      tx('cbc:LineExtensionAmount', money(net), SAR),
      tx('cbc:TaxExclusiveAmount', money(net), SAR),
      tx('cbc:TaxInclusiveAmount', money(net + vat), SAR),
      tx('cbc:AllowanceTotalAmount', '0.00', SAR),
      tx('cbc:PrepaidAmount', '0.00', SAR),
      tx('cbc:PayableAmount', money(net + vat), SAR),
    ),
    ...input.lines.map((line, index) =>
      el(
        'cac:InvoiceLine',
        null,
        tx('cbc:ID', String(index + 1)),
        tx('cbc:InvoicedQuantity', '1.000000', { unitCode: 'PCE' }),
        tx('cbc:LineExtensionAmount', money(line.net), SAR),
        el('cac:TaxTotal', null, tx('cbc:TaxAmount', money(line.vat), SAR), tx('cbc:RoundingAmount', money(line.net + line.vat), SAR)),
        el('cac:Item', null, tx('cbc:Name', line.name), taxCategory('cac:ClassifiedTaxCategory', input.vatRate)),
        el('cac:Price', null, tx('cbc:PriceAmount', money(line.net), SAR)),
      ),
    ),
  ].filter(Boolean) as string[];

  return { head, tail, date, time, total: money(net + vat), vat: money(vat) };
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest();
/** ZATCA's quirk for the certificate and signed-properties digests: base64 of the hex text. */
const hexBase64 = (data: string) => Buffer.from(sha256(Buffer.from(data, 'utf8')).toString('hex')).toString('base64');

/** The document as ZATCA hashes it, after its transforms remove UBLExtensions, cac:Signature and the QR. */
export function pureDocument(input: ZatcaDocumentInput) {
  const { head, tail } = documentParts(input);
  return el('Invoice', ROOT_ATTRS, ...head, ...tail);
}

/** Base64 SHA-256 of the canonical document: the DigestValue, the next PIH and QR tag 6. */
export const documentHash = (pure: string) => sha256(Buffer.from(pure, 'utf8')).toString('base64');

/** Tag-length-value, one length byte, as both QR phases use. */
export function tlv(values: (string | Buffer)[]) {
  return Buffer.concat(
    values.map((value, index) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
      if (bytes.length > 255) throw new Error(`QR tag ${index + 1} is longer than 255 bytes`);
      return Buffer.concat([Buffer.from([index + 1, bytes.length]), bytes]);
    }),
  ).toString('base64');
}

/** The XAdES signed properties exactly as they are digested and written: each namespace declared where first used. */
export function signedPropertiesXml(signingTime: string, cert: CertificateInfo) {
  const ds = { 'xmlns:ds': NS.ds };
  return el(
    'xades:SignedProperties',
    { 'xmlns:xades': NS.xades, Id: 'xadesSignedProperties' },
    el(
      'xades:SignedSignatureProperties',
      null,
      tx('xades:SigningTime', signingTime),
      el(
        'xades:SigningCertificate',
        null,
        el(
          'xades:Cert',
          null,
          el('xades:CertDigest', null, el('ds:DigestMethod', { ...ds, Algorithm: SHA256 }), tx('ds:DigestValue', cert.hash, ds)),
          el('xades:IssuerSerial', null, tx('ds:X509IssuerName', cert.issuer, ds), tx('ds:X509SerialNumber', cert.serialNumber, ds)),
        ),
      ),
    ),
  );
}

export type SignedDocument = { xml: string; hash: string; signature: string; qr: string; signingTime: string };

/**
 * Signs a document: the hash of the pure form, an ECDSA-SHA256 signature over that hash (as ZATCA's
 * SDK signs it), the XAdES block, the cac:Signature marker and the phase-2 QR (tags 1–9).
 */
export function signDocument(input: ZatcaDocumentInput, key: { privateKey: crypto.KeyObject | string; certificateBody: string; cert: CertificateInfo }, signedAt = new Date()): SignedDocument {
  const parts = documentParts(input);
  const pure = el('Invoice', ROOT_ATTRS, ...parts.head, ...parts.tail);
  const hash = documentHash(pure);
  const signature = crypto.sign('sha256', Buffer.from(hash, 'base64'), key.privateKey).toString('base64');
  const signing = riyadhDateTime(signedAt);
  const signingTime = `${signing.date}T${signing.time}`;
  const properties = signedPropertiesXml(signingTime, key.cert);
  const propertiesHash = hexBase64(properties);

  const xpath = (expression: string) => el('ds:Transform', { Algorithm: XPATH }, tx('ds:XPath', expression));
  const signatureXml = el(
    'ds:Signature',
    { 'xmlns:ds': NS.ds, Id: 'signature' },
    el(
      'ds:SignedInfo',
      null,
      el('ds:CanonicalizationMethod', { Algorithm: C14N11 }),
      el('ds:SignatureMethod', { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' }),
      el(
        'ds:Reference',
        { Id: 'invoiceSignedData', URI: '' },
        el(
          'ds:Transforms',
          null,
          xpath('not(//ancestor-or-self::ext:UBLExtensions)'),
          xpath('not(//ancestor-or-self::cac:Signature)'),
          xpath("not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"),
          el('ds:Transform', { Algorithm: C14N11 }),
        ),
        el('ds:DigestMethod', { Algorithm: SHA256 }),
        tx('ds:DigestValue', hash),
      ),
      el(
        'ds:Reference',
        { Type: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties', URI: '#xadesSignedProperties' },
        el('ds:DigestMethod', { Algorithm: SHA256 }),
        tx('ds:DigestValue', propertiesHash),
      ),
    ),
    tx('ds:SignatureValue', signature),
    el('ds:KeyInfo', null, el('ds:X509Data', null, tx('ds:X509Certificate', key.certificateBody))),
    el('ds:Object', null, el('xades:QualifyingProperties', { 'xmlns:xades': NS.xades, Target: 'signature' }, properties)),
  );

  const extensions = el(
    'ext:UBLExtensions',
    null,
    el(
      'ext:UBLExtension',
      null,
      tx('ext:ExtensionURI', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'),
      el(
        'ext:ExtensionContent',
        null,
        el(
          'sig:UBLDocumentSignatures',
          { 'xmlns:sig': NS.sig, 'xmlns:sac': NS.sac, 'xmlns:sbc': NS.sbc },
          el(
            'sac:SignatureInformation',
            null,
            tx('cbc:ID', 'urn:oasis:names:specification:ubl:signature:1'),
            tx('sbc:ReferencedSignatureID', 'urn:oasis:names:specification:ubl:signature:Invoice'),
            signatureXml,
          ),
        ),
      ),
    ),
  );

  const qr = tlv([input.seller.name, input.seller.vatNumber, `${parts.date}T${parts.time}`, parts.total, parts.vat, hash, signature, key.cert.publicKey, key.cert.signature]);
  const qrReference = el('cac:AdditionalDocumentReference', null, tx('cbc:ID', 'QR'), el('cac:Attachment', null, tx('cbc:EmbeddedDocumentBinaryObject', qr, { mimeCode: 'text/plain' })));
  const signatureMarker = el('cac:Signature', null, tx('cbc:ID', 'urn:oasis:names:specification:ubl:signature:Invoice'), tx('cbc:SignatureMethod', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${el('Invoice', ROOT_ATTRS, extensions, ...parts.head, qrReference, signatureMarker, ...parts.tail)}`;
  return { xml, hash, signature, qr, signingTime };
}

/**
 * Re-does ZATCA's checks on a signed document, for tests and for a sanity check before sending:
 * strips the three removed parts, re-hashes, compares with the DigestValue and verifies the signature.
 */
export function verifySignedXml(xml: string, publicKey: crypto.KeyObject | string) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const pure = body
    .replace(/<ext:UBLExtensions>.*?<\/ext:UBLExtensions>/s, '')
    .replace(/<cac:Signature>.*?<\/cac:Signature>/s, '')
    .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>.*?<\/cac:AdditionalDocumentReference>/s, '');
  const hash = documentHash(pure);
  const digest = /<ds:Reference Id="invoiceSignedData" URI="">.*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/s.exec(body)?.[1];
  const signature = /<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/.exec(body)?.[1] ?? '';
  const properties = /<xades:SignedProperties .*?<\/xades:SignedProperties>/s.exec(body)?.[0] ?? '';
  const propertiesDigest = /URI="#xadesSignedProperties">.*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/s.exec(body)?.[1];
  return {
    hash,
    hashMatches: digest === hash,
    propertiesMatch: hexBase64(properties) === propertiesDigest,
    signatureValid: crypto.verify('sha256', Buffer.from(hash, 'base64'), publicKey, Buffer.from(signature, 'base64')),
  };
}

/** Splits a TLV QR back into its fields, for tests and the admin's check. */
export function readTlv(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  const fields: Record<number, Buffer> = {};
  for (let offset = 0; offset < bytes.length; ) {
    const tag = bytes[offset];
    const size = bytes[offset + 1];
    fields[tag] = bytes.subarray(offset + 2, offset + 2 + size);
    offset += 2 + size;
  }
  return fields;
}
