import { INestApplication } from '@nestjs/common';
import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as request from 'supertest';
import { InvoiceLedgerService } from '../src/common/services/invoice-ledger.service';
import { PrismaService } from '../src/common/services/prisma.service';
import { der, oid, printableString, readNode, sequence, set } from '../src/modules/zatca/zatca-asn1.util';
import { FIRST_PREVIOUS_HASH, readTlv, verifySignedXml } from '../src/modules/zatca/zatca-xml.util';
import { ZatcaService } from '../src/modules/zatca/zatca.service';
import { API, createStaff, createTestApp, loginStaff, resetDatabase, tripPayload } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

/** The CSR's public key, as ZATCA would read it to issue the certificate. */
function csrPublicKey(csrPem: string) {
  const raw = Buffer.from(csrPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const top = readNode(raw, 0);
  const info = readNode(raw, top.contentStart);
  let offset = info.contentStart;
  const nodes = [];
  while (offset < info.end) {
    const node = readNode(raw, offset);
    nodes.push(node);
    offset = node.end;
  }
  return raw.subarray(nodes[2].start, nodes[2].end);
}

/** A certificate for that key signed by a throwaway CA, standing in for ZATCA's issuing CA. */
function issueCertificate(spki: Buffer, ca: crypto.KeyObject) {
  const utc = (date: Date) => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));
  const name = (cn: string) => sequence(set(sequence(oid('2.5.4.3'), printableString(cn))));
  const ecdsaSha256 = sequence(oid('1.2.840.10045.4.3.2'));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, 0x23, 0x45])),
    ecdsaSha256,
    name('TSZEINVOICE-SubCA-1'),
    sequence(utc(new Date(Date.now() - DAY)), utc(new Date(Date.now() + 365 * DAY))),
    name('EGS'),
    spki,
  );
  const signature = crypto.sign('sha256', tbs, ca);
  const cert = sequence(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  // ZATCA's binarySecurityToken is base64 of the base64 body.
  return Buffer.from(cert.toString('base64')).toString('base64');
}

describe('ZATCA phase 2 e-invoicing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { auth: Record<string, string> };
  let adminUserId: string;
  let tripId: string;
  let stub: http.Server;
  let issuedPublicKey: crypto.KeyObject | null = null;
  let rejectNext = false;
  const calls: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const ca = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;

  const server = () => app.getHttpServer();
  const get = (url: string) => request(server()).get(`${API}${url}`).set(admin.auth);
  const send = (method: 'post' | 'put', url: string, body: object = {}) => request(server())[method](`${API}${url}`).set(admin.auth).send(body);

  const makeInvoice = async (total = 115) => {
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `DR-Z-${crypto.randomUUID().slice(0, 8)}`,
        userId: adminUserId,
        tripId,
        source: 'BRANCH',
        status: 'CONFIRMED',
        totalPrice: total,
        passengers: { create: [{ fullName: 'ناصر الحربي', nationalId: '1012345678', phone: '+966544102231', seatNumber: '4' }] },
        payment: { create: { amount: total, walletAmount: 0, status: 'COMPLETED', method: 'cash' } },
      },
    });
    const invoice = await prisma.$transaction((tx) => app.get(InvoiceLedgerService).ensure(tx, booking.id));
    return { booking, invoice };
  };

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        const body = text ? JSON.parse(text) : {};
        const path = (req.url ?? '').replace(/^\/simulation/, '');
        calls.push({ path, headers: req.headers, body });
        const reply = (status: number, payload: object) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (path === '/compliance') {
          if (req.headers.otp !== '123456') return reply(400, { errors: [{ code: 'Invalid-OTP', message: 'Invalid OTP' }] });
          const csrPem = Buffer.from(body.csr, 'base64').toString('utf8');
          const spki = csrPublicKey(csrPem);
          issuedPublicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
          return reply(200, { requestID: 1234567890123, dispositionMessage: 'ISSUED', binarySecurityToken: issueCertificate(spki, ca), secret: 'compliance-secret' });
        }
        if (path === '/compliance/invoices') {
          const xml = Buffer.from(body.invoice, 'base64').toString('utf8');
          const check = verifySignedXml(xml, issuedPublicKey!);
          const ok = check.hashMatches && check.signatureValid && check.hash === body.invoiceHash;
          return reply(ok ? 200 : 400, { validationResults: { status: ok ? 'PASS' : 'ERROR', warningMessages: [], errorMessages: ok ? [] : [{ code: 'signature', message: 'bad' }] } });
        }
        if (path === '/production/csids') {
          return reply(200, { requestID: 99, binarySecurityToken: issueCertificate(spkiOf(issuedPublicKey!), ca), secret: 'production-secret' });
        }
        if (path === '/invoices/reporting/single') {
          if (rejectNext) {
            rejectNext = false;
            return reply(400, { reportingStatus: 'NOT_REPORTED', validationResults: { status: 'ERROR', errorMessages: [{ code: 'BR-KSA-XX', message: 'rejected on purpose' }] } });
          }
          const xml = Buffer.from(body.invoice, 'base64').toString('utf8');
          const check = verifySignedXml(xml, issuedPublicKey!);
          return reply(check.hashMatches && check.signatureValid ? 200 : 400, { reportingStatus: 'REPORTED', validationResults: { status: 'PASS', warningMessages: [], errorMessages: [] } });
        }
        reply(404, { message: 'not found' });
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    process.env.ZATCA_API_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const adminUser = await createStaff(prisma, 'ADMIN');
    adminUserId = adminUser.id;
    admin = await loginStaff(app, adminUser.phone);
    const trip = (await send('post', '/trips', tripPayload()).expect(201)).body;
    tripId = trip.id;
    await prisma.trip.update({ where: { id: tripId }, data: { departureTime: new Date(Date.now() + 2 * DAY), arrivalTime: new Date(Date.now() + 2 * DAY + 3600000) } });
    await send('put', '/settings', { vatNumber: '399999999900003', crNumber: '1010010000' }).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => stub.close(resolve));
  });

  const spkiOf = (key: crypto.KeyObject) => key.export({ type: 'spki', format: 'der' });

  it('is off by default and invoices keep the phase-1 QR', async () => {
    const status = (await get('/zatca/status').expect(200)).body;
    expect(status).toMatchObject({ enabled: false, stage: 'NONE', environment: 'simulation' });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE KEY|secret/i);

    const { booking } = await makeInvoice();
    const printable = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;
    expect(printable.qrPhase).toBe(1);
    expect(Object.keys(readTlv(printable.qr))).toEqual(['1', '2', '3', '4', '5']);
    expect(await prisma.zatcaDocument.count()).toBe(0);
    await app.get(ZatcaService).sweep();
    expect(await prisma.zatcaDocument.count()).toBe(0);
  });

  it('refuses to onboard or switch on before the details are complete', async () => {
    const status = (await get('/zatca/status').expect(200)).body;
    expect(status.problems.length).toBeGreaterThan(0);
    await send('post', '/zatca/onboarding/compliance', { code: '123456' }).expect(400);
    await send('put', '/zatca/enabled', { enabled: true }).expect(400);
  });

  it('onboards: OTP, compliance checks, production certificate', async () => {
    await send('put', '/zatca/config', {
      address: { street: 'شارع الملك عبدالعزيز', building: '1234', district: 'الصريف', city: 'ينبع', postalCode: '46455' },
      csr: { organizationUnit: 'الفرع الرئيسي', location: 'Yanbu', industry: 'Transportation' },
    }).expect(200);
    expect((await get('/zatca/status').expect(200)).body.problems).toEqual([]);

    await send('post', '/zatca/onboarding/compliance', { code: '000000' }).expect(400);
    const afterOtp = (await send('post', '/zatca/onboarding/compliance', { code: '123456' }).expect(200)).body;
    expect(afterOtp.stage).toBe('COMPLIANCE');
    expect(afterOtp.privateKeyReadable).toBe(true);
    const stored = await prisma.setting.findUnique({ where: { key: 'zatca.privateKey' } });
    expect(stored.value).toMatch(/^v1:/);
    expect(stored.value).not.toContain('PRIVATE KEY');

    const checked = (await send('post', '/zatca/onboarding/checks').expect(200)).body;
    expect(checked.stage).toBe('CHECKED');
    expect(checked.compliance.checks.items.map((item: any) => item.status)).toEqual(['PASS', 'PASS', 'PASS']);

    const production = (await send('post', '/zatca/onboarding/production').expect(200)).body;
    expect(production.stage).toBe('PRODUCTION');
    expect(calls.find((call) => call.path === '/production/csids').body).toEqual({ compliance_request_id: '1234567890123' });

    const enabled = (await send('put', '/zatca/enabled', { enabled: true }).expect(200)).body;
    expect(enabled.enabled).toBe(true);
    expect(enabled.activatedAt).toBeTruthy();
  });

  it('chains, signs and reports new invoices in order', async () => {
    const first = await makeInvoice(115);
    const second = await makeInvoice(230);
    const result = await app.get(ZatcaService).sweep();
    expect(result.signed).toBe(2);

    const docs = await prisma.zatcaDocument.findMany({ orderBy: { icv: 'asc' } });
    expect(docs.map((doc) => doc.icv)).toEqual([1, 2]);
    expect(docs[0].previousHash).toBe(FIRST_PREVIOUS_HASH);
    expect(docs[1].previousHash).toBe(docs[0].invoiceHash);
    expect(docs.map((doc) => doc.status)).toEqual(['REPORTED', 'REPORTED']);
    for (const doc of docs) {
      expect(verifySignedXml(doc.xml, issuedPublicKey)).toMatchObject({ hashMatches: true, signatureValid: true, propertiesMatch: true });
      expect(doc.xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
    }

    const printable = (await get(`/invoices/bookings/${first.booking.id}`).expect(200)).body;
    expect(printable.qrPhase).toBe(2);
    const tags = readTlv(printable.qr);
    expect(Object.keys(tags)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(tags[6].toString()).toBe(docs[0].invoiceHash);
    expect(tags[8]).toEqual(spkiOf(issuedPublicKey));
    expect(second.invoice.id).toBe(docs[1].invoiceId);

    const register = (await get('/invoices').expect(200)).body;
    expect(register.items.find((row: any) => row.id === first.invoice.id).zatcaStatus).toBe('REPORTED');
  });

  it('signs on demand when an invoice is printed before the worker reaches it', async () => {
    const { booking, invoice } = await makeInvoice();
    const printable = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;
    expect(printable.qrPhase).toBe(2);
    const doc = await prisma.zatcaDocument.findUnique({ where: { invoiceId: invoice.id } });
    expect(doc.icv).toBe(3);
    expect(doc.status).toBe('PENDING');
  });

  it('reports credit notes as 381 against the invoice', async () => {
    await app.get(ZatcaService).sweep();
    const { booking, invoice } = await makeInvoice();
    await prisma.$transaction((tx) => app.get(InvoiceLedgerService).credit(tx, { bookingId: booking.id, amount: 5750, reason: 'إلغاء الحجز' }));
    await app.get(ZatcaService).sweep();
    const note = await prisma.zatcaDocument.findFirst({ where: { kind: 'CREDIT_NOTE' } });
    expect(note.xml).toContain('>381</cbc:InvoiceTypeCode>');
    expect(note.xml).toContain('<cac:BillingReference>');
    expect(note.xml).toContain('<cbc:InstructionNote>إلغاء الحجز</cbc:InstructionNote>');
    expect(note.status).toBe('REPORTED');
    const invoiceDoc = await prisma.zatcaDocument.findUnique({ where: { invoiceId: invoice.id } });
    expect(note.icv).toBe(invoiceDoc.icv + 1);
  });

  it('keeps a rejection, lists it, retries it and serves the XML', async () => {
    rejectNext = true;
    const { invoice } = await makeInvoice();
    await app.get(ZatcaService).sweep();
    const doc = await prisma.zatcaDocument.findUnique({ where: { invoiceId: invoice.id } });
    expect(doc.status).toBe('REJECTED');
    expect(doc.errorMessage).toContain('rejected on purpose');

    const list = (await get('/zatca/documents').query({ status: 'REJECTED' }).expect(200)).body;
    expect(list.items.map((row: any) => row.id)).toEqual([doc.id]);

    const retried = (await send('post', `/zatca/documents/${doc.id}/retry`).expect(200)).body;
    expect(retried.status).toBe('REPORTED');
    const unchanged = await prisma.zatcaDocument.findUnique({ where: { id: doc.id } });
    expect(unchanged.invoiceHash).toBe(doc.invoiceHash);

    const file = (await get(`/zatca/documents/${doc.id}/xml`).expect(200)).body;
    expect(file.fileName).toMatch(/^INV-.*\.xml$/);
    expect(file.xml.startsWith('<?xml')).toBe(true);
  });

  it('switching off stops signing new invoices but the printout falls back to phase 1', async () => {
    await send('put', '/zatca/enabled', { enabled: false }).expect(200);
    const { booking, invoice } = await makeInvoice();
    await app.get(ZatcaService).sweep();
    expect(await prisma.zatcaDocument.findUnique({ where: { invoiceId: invoice.id } })).toBeNull();
    const printable = (await get(`/invoices/bookings/${booking.id}`).expect(200)).body;
    expect(printable.qrPhase).toBe(1);
  });
});
