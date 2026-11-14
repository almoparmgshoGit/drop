import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ZatcaStatus } from '@prisma/client';
import * as crypto from 'crypto';
import { InvoiceLedgerService } from '../../common/services/invoice-ledger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { creditNoteNumber, invoiceNumber } from '../../common/utils/invoice.util';
import { halalas } from '../../common/utils/payment.util';
import { buildCsr, certificateBody, certificateInfo } from './zatca-asn1.util';
import { ZATCA_ENVIRONMENTS, ZatcaApiClient, ZatcaApiError, ZatcaEnvironment, ZatcaSubmitResult, isZatcaEnvironment } from './zatca-api.client';
import { FIRST_PREVIOUS_HASH, ZatcaDocumentInput, ZatcaDocumentKind, ZatcaSeller, signDocument } from './zatca-xml.util';
import { ZatcaConfigDto, ZatcaDocumentsQuery } from './zatca.dto';

const PREFIX = 'zatca.';
const SECRET_KEYS = new Set(['privateKey', 'complianceSecret', 'productionSecret']);
const CIPHER_VERSION = 'v1';
/** Serializes ICV assignment across every server: one chain, one writer at a time. */
const CHAIN_LOCK = 73_110_001;
const SIGN_BATCH = 50;
const REPORT_BATCH = 20;
const MAX_ATTEMPTS = 12;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const AUTH_WAIT_MS = 30 * 60_000;
const STALE_CLAIM_MS = 5 * 60_000;
const REPORT_DEADLINE_MS = 24 * 3600_000;
const PAGE_SIZE = 50;

type Stage = 'NONE' | 'COMPLIANCE' | 'CHECKED' | 'PRODUCTION';
type AddressConfig = { street: string; building: string; additionalNumber: string; district: string; city: string; postalCode: string };
type CsrConfig = { commonName: string; organizationUnit: string; location: string; industry: string; serial: string };
type CheckResult = { type: string; status: string; httpStatus: number; warnings: string[]; errors: string[] };

const EMPTY_ADDRESS: AddressConfig = { street: '', building: '', additionalNumber: '', district: '', city: '', postalCode: '' };

const PAYMENT_MEANS: Record<string, string> = { cash: '10', transfer: '30', card: '48', mada: '48', network: '48' };

const messagesOf = (list: unknown) =>
  (Array.isArray(list) ? list : []).map((item: any) => (typeof item === 'string' ? item : [item?.code, item?.message].filter(Boolean).join(': '))).filter(Boolean) as string[];

const parseJson = <T>(text: string | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return { ...fallback, ...JSON.parse(text) };
  } catch {
    return fallback;
  }
};

/**
 * ZATCA phase 2 for simplified (B2C) invoices: onboarding, the signed hash chain, and the queue that
 * reports each document within 24 hours. Off until an admin finishes onboarding and switches it on;
 * until then nothing is signed and invoices print the phase-1 QR exactly as before.
 */
@Injectable()
export class ZatcaService {
  private readonly logger = new Logger(ZatcaService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private ledger: InvoiceLedgerService,
  ) {}

  // ---------- settings and secrets ----------

  private cipherKey() {
    const secret = this.config.get<string>('SETTINGS_ENCRYPTION_KEY');
    return secret ? crypto.createHash('sha256').update(secret).digest() : null;
  }

  /** The same scheme as the integration keys, so one SETTINGS_ENCRYPTION_KEY protects both. */
  private encrypt(plain: string) {
    const key = this.cipherKey();
    if (!key) throw new ServiceUnavailableException('لا يمكن حفظ مفاتيح الفوترة الإلكترونية: ضع SETTINGS_ENCRYPTION_KEY في ملف بيئة الخادم أولًا');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [CIPHER_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  private decrypt(stored: string | undefined) {
    const key = this.cipherKey();
    const [version, iv, tag, data] = (stored ?? '').split(':');
    if (!key || version !== CIPHER_VERSION || !iv || !tag || data === undefined) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private async readAll(): Promise<Record<string, string>> {
    const rows = await this.prisma.setting.findMany({ where: { key: { startsWith: PREFIX } } });
    return Object.fromEntries(rows.map((row) => [row.key.slice(PREFIX.length), row.value]));
  }

  /** Null removes the key. Secrets are encrypted on the way in. */
  private async write(values: Record<string, string | null>) {
    const writes = Object.entries(values).map(([key, value]) =>
      value === null
        ? this.prisma.setting.deleteMany({ where: { key: `${PREFIX}${key}` } })
        : this.prisma.setting.upsert({
            where: { key: `${PREFIX}${key}` },
            create: { key: `${PREFIX}${key}`, value: SECRET_KEYS.has(key) ? this.encrypt(value) : value },
            update: { value: SECRET_KEYS.has(key) ? this.encrypt(value) : value },
          }),
    );
    await this.prisma.$transaction(writes);
  }

  private environmentOf(stored: Record<string, string>): ZatcaEnvironment {
    return isZatcaEnvironment(stored.environment) ? stored.environment : 'simulation';
  }

  private client(environment: ZatcaEnvironment) {
    return new ZatcaApiClient(environment, this.config.get<string>('ZATCA_API_BASE_URL'));
  }

  private async sellerOf(stored: Record<string, string>) {
    const invoice = await this.ledger.invoiceSettings(this.prisma);
    const address = parseJson<AddressConfig>(stored.address, EMPTY_ADDRESS);
    return { name: invoice.sellerName, vatNumber: invoice.vatNumber, crNumber: invoice.crNumber, ...address };
  }

  private csrOf(stored: Record<string, string>, vatNumber: string): CsrConfig {
    const csr = parseJson<CsrConfig>(stored.csr, { commonName: '', organizationUnit: '', location: '', industry: '', serial: '' });
    return { ...csr, commonName: csr.commonName || `DUROB-${vatNumber || 'EGS'}` };
  }

  /** What still stops onboarding, in the words the admin needs. */
  private problems(seller: Awaited<ReturnType<ZatcaService['sellerOf']>>, csr: CsrConfig) {
    const problems: string[] = [];
    if (!this.cipherKey()) problems.push('مفتاح التشفير SETTINGS_ENCRYPTION_KEY غير مضبوط في ملف بيئة الخادم');
    if (!seller.name) problems.push('اسم المنشأة فارغ (إعدادات الفاتورة الضريبية)');
    if (!/^3\d{13}3$/.test(seller.vatNumber)) problems.push('الرقم الضريبي يجب أن يكون 15 رقمًا يبدأ وينتهي بالرقم 3 (إعدادات الفاتورة الضريبية)');
    if (!/^\d{10}$/.test(seller.crNumber)) problems.push('السجل التجاري يجب أن يكون 10 أرقام (إعدادات الفاتورة الضريبية)');
    if (!seller.street) problems.push('اسم الشارع مطلوب');
    if (!/^\d{4}$/.test(seller.building)) problems.push('رقم المبنى 4 أرقام');
    if (seller.additionalNumber && !/^\d{4}$/.test(seller.additionalNumber)) problems.push('الرقم الإضافي 4 أرقام');
    if (!seller.district) problems.push('اسم الحي مطلوب');
    if (!seller.city) problems.push('المدينة مطلوبة');
    if (!/^\d{5}$/.test(seller.postalCode)) problems.push('الرمز البريدي 5 أرقام');
    if (!csr.organizationUnit) problems.push('اسم الفرع أو الوحدة مطلوب لطلب الشهادة');
    if (!csr.location) problems.push('عنوان الفرع المختصر مطلوب لطلب الشهادة');
    if (!csr.industry) problems.push('نشاط المنشأة مطلوب لطلب الشهادة');
    return problems;
  }

  // ---------- admin: status, configuration, onboarding ----------

  async status() {
    const stored = await this.readAll();
    const environment = this.environmentOf(stored);
    const seller = await this.sellerOf(stored);
    const csr = this.csrOf(stored, seller.vatNumber);
    const stage = (stored.stage as Stage) || 'NONE';
    let production: { issuer: string; validTo: string } | null = null;
    if (stored.productionToken) {
      try {
        const cert = new crypto.X509Certificate(Buffer.from(certificateBody(stored.productionToken), 'base64'));
        production = { issuer: cert.issuer.replace(/\n/g, ', '), validTo: new Date(cert.validTo).toISOString() };
      } catch {
        production = { issuer: '', validTo: '' };
      }
    }
    const [grouped, unsigned, overdue] = await Promise.all([
      this.prisma.zatcaDocument.groupBy({ by: ['status'], where: { environment }, _count: true }),
      this.prisma.zatcaDocument.count({ where: { environment, signedAt: null } }),
      this.prisma.zatcaDocument.count({ where: { environment, status: 'PENDING', createdAt: { lt: new Date(Date.now() - REPORT_DEADLINE_MS) } } }),
    ]);
    const counts = Object.fromEntries(Object.keys(ZatcaStatus).map((status) => [status, grouped.find((row) => row.status === status)?._count ?? 0]));
    return {
      encryptionReady: !!this.cipherKey(),
      enabled: stored.enabled === 'true',
      environment,
      environments: Object.entries(ZATCA_ENVIRONMENTS).map(([value, item]) => ({ value, label: item.label })),
      stage,
      activatedAt: stored.activatedAt || null,
      seller,
      csr: { commonName: csr.commonName, organizationUnit: csr.organizationUnit, location: csr.location, industry: csr.industry },
      problems: this.problems(seller, csr),
      privateKeyStored: !!stored.privateKey,
      privateKeyReadable: !!stored.privateKey && this.decrypt(stored.privateKey) !== null,
      compliance: { requestId: stored.complianceRequestId || null, checks: parseJson<{ items: CheckResult[]; at: string | null }>(stored.checks, { items: [], at: null }) },
      production,
      counts: { ...counts, unsigned, overdue },
      lastError: stored.lastError || null,
    };
  }

  async updateConfig(dto: ZatcaConfigDto) {
    const stored = await this.readAll();
    const writes: Record<string, string | null> = {};
    if (dto.environment && dto.environment !== this.environmentOf(stored)) {
      if (!isZatcaEnvironment(dto.environment)) throw new BadRequestException('البيئة غير معروفة');
      // A new environment is a new chain with new certificates, so onboarding starts over.
      Object.assign(writes, {
        environment: dto.environment,
        enabled: 'false',
        stage: 'NONE',
        activatedAt: null,
        privateKey: null,
        complianceToken: null,
        complianceSecret: null,
        complianceRequestId: null,
        checks: null,
        productionToken: null,
        productionSecret: null,
        lastError: null,
      });
      // Whatever the old environment still owed can no longer be sent with its certificate.
      await this.prisma.zatcaDocument.updateMany({
        where: { environment: this.environmentOf(stored), status: 'PENDING' },
        data: { status: 'FAILED', errorMessage: 'تغيّرت بيئة الربط قبل إبلاغ هذا المستند', claimedAt: null },
      });
    }
    if (dto.address) {
      const current = parseJson<AddressConfig>(stored.address, EMPTY_ADDRESS);
      writes.address = JSON.stringify({ ...current, ...dto.address });
    }
    if (dto.csr) {
      const current = parseJson<CsrConfig>(stored.csr, { commonName: '', organizationUnit: '', location: '', industry: '', serial: '' });
      writes.csr = JSON.stringify({ ...current, ...dto.csr });
    }
    if (Object.keys(writes).length) await this.write(writes);
    return this.status();
  }

  /** Step 1: new key pair and CSR, exchanged with the portal's OTP for the compliance certificate. */
  async requestComplianceCsid(otp: string) {
    const stored = await this.readAll();
    const environment = this.environmentOf(stored);
    const seller = await this.sellerOf(stored);
    const csr = this.csrOf(stored, seller.vatNumber);
    const problems = this.problems(seller, csr);
    if (problems.length) throw new BadRequestException(`أكمل البيانات أولًا: ${problems.join('، ')}`);

    const serial = csr.serial || `1-Durob|2-Admin|3-${crypto.randomUUID()}`;
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const csrPem = buildCsr(
      {
        commonName: csr.commonName,
        organizationUnit: csr.organizationUnit,
        organization: seller.name,
        serialNumber: serial,
        vatNumber: seller.vatNumber,
        // Simplified invoices only: this system issues no B2B tax invoices.
        invoiceType: '0100',
        location: csr.location,
        industry: csr.industry,
        template: ZATCA_ENVIRONMENTS[environment].template,
      },
      privateKey,
    );
    try {
      const result = await this.client(environment).complianceCsid(csrPem, otp);
      await this.write({
        csr: JSON.stringify({ ...csr, serial }),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        complianceToken: result.binarySecurityToken,
        complianceSecret: result.secret,
        complianceRequestId: String(result.requestID ?? ''),
        checks: null,
        stage: 'COMPLIANCE',
        // A new key cannot sign with the old production certificate, so signing waits for step 3.
        enabled: 'false',
        lastError: null,
      });
    } catch (err) {
      await this.recordError(err);
      throw this.asHttp(err);
    }
    return this.status();
  }

  /** Step 2: the samples ZATCA requires for a simplified-only unit, signed with the compliance certificate. */
  async runComplianceChecks() {
    const stored = await this.readAll();
    const environment = this.environmentOf(stored);
    const privateKey = this.decrypt(stored.privateKey);
    const secret = this.decrypt(stored.complianceSecret);
    if (!privateKey || !secret || !stored.complianceToken) throw new BadRequestException('اطلب شهادة الامتثال أولًا');
    const seller = await this.sellerOf(stored);
    const body = certificateBody(stored.complianceToken);
    const key = { privateKey, certificateBody: body, cert: certificateInfo(body) };
    const auth = { token: stored.complianceToken, secret };

    const samples: { type: string; kind: ZatcaDocumentKind }[] = [
      { type: 'فاتورة مبسطة', kind: 'INVOICE' },
      { type: 'إشعار دائن مبسط', kind: 'CREDIT_NOTE' },
      { type: 'إشعار مدين مبسط', kind: 'DEBIT_NOTE' },
    ];
    let previousHash = FIRST_PREVIOUS_HASH;
    const items: CheckResult[] = [];
    try {
      for (const [index, sample] of samples.entries()) {
        const input: ZatcaDocumentInput = {
          kind: sample.kind,
          number: `CMP-${Date.now()}-${index + 1}`,
          uuid: crypto.randomUUID(),
          icv: index + 1,
          previousHash,
          issuedAt: new Date(),
          seller: this.zatcaSeller(seller),
          buyerName: 'عميل',
          lines: [{ name: 'حجز رحلة', net: 8696, vat: 1304 }],
          vatRate: 15,
          billingReference: sample.kind === 'INVOICE' ? undefined : 'CMP-1',
          reason: sample.kind === 'INVOICE' ? undefined : 'إلغاء الحجز',
          paymentMeansCode: '10',
        };
        const signed = signDocument(input, key);
        previousHash = signed.hash;
        const result = await this.client(environment).complianceInvoice(auth, { hash: signed.hash, uuid: input.uuid, xml: signed.xml });
        items.push(this.checkResult(sample.type, result));
      }
    } catch (err) {
      await this.recordError(err);
      throw this.asHttp(err);
    }
    const passed = items.every((item) => item.errors.length === 0 && ['PASS', 'WARNING'].includes(item.status));
    await this.write({ checks: JSON.stringify({ items, at: new Date().toISOString() }), stage: passed ? 'CHECKED' : 'COMPLIANCE', lastError: passed ? null : 'لم تجتز كل عينات فحص الامتثال' });
    return this.status();
  }

  /** Step 3: the production certificate that signs real invoices. */
  async requestProductionCsid() {
    const stored = await this.readAll();
    if (stored.stage !== 'CHECKED') throw new BadRequestException('أكمل فحص الامتثال بنجاح أولًا');
    const secret = this.decrypt(stored.complianceSecret);
    if (!secret || !stored.complianceToken || !stored.complianceRequestId) throw new BadRequestException('اطلب شهادة الامتثال أولًا');
    try {
      const result = await this.client(this.environmentOf(stored)).productionCsid({ token: stored.complianceToken, secret }, stored.complianceRequestId);
      await this.write({
        productionToken: result.binarySecurityToken,
        productionSecret: result.secret,
        productionRequestId: String(result.requestID ?? ''),
        stage: 'PRODUCTION',
        lastError: null,
      });
    } catch (err) {
      await this.recordError(err);
      throw this.asHttp(err);
    }
    return this.status();
  }

  async setEnabled(enabled: boolean) {
    const stored = await this.readAll();
    if (enabled) {
      if (stored.stage !== 'PRODUCTION' || !stored.productionToken) throw new BadRequestException('أكمل خطوات الربط والحصول على شهادة الإنتاج أولًا');
      if (!this.decrypt(stored.privateKey) || !this.decrypt(stored.productionSecret)) throw new BadRequestException('تعذرت قراءة المفاتيح المحفوظة، ربما تغيّر مفتاح التشفير. أعد خطوات الربط');
      const seller = await this.sellerOf(stored);
      const problems = this.problems(seller, this.csrOf(stored, seller.vatNumber));
      if (problems.length) throw new BadRequestException(`أكمل البيانات أولًا: ${problems.join('، ')}`);
    }
    // Invoices issued from the first switch-on belong to the chain, even if it is paused and resumed later.
    await this.write({ enabled: enabled ? 'true' : 'false', ...(enabled && !stored.activatedAt && { activatedAt: new Date().toISOString() }) });
    return this.status();
  }

  private zatcaSeller(seller: Awaited<ReturnType<ZatcaService['sellerOf']>>, frozen?: { name?: string; vatNumber?: string; crNumber?: string } | null): ZatcaSeller {
    return {
      name: frozen?.name || seller.name,
      vatNumber: frozen?.vatNumber || seller.vatNumber,
      crNumber: frozen?.crNumber || seller.crNumber,
      street: seller.street,
      building: seller.building,
      additionalNumber: seller.additionalNumber || undefined,
      district: seller.district,
      city: seller.city,
      postalCode: seller.postalCode,
    };
  }

  private checkResult(type: string, result: ZatcaSubmitResult): CheckResult {
    const validation = result.body?.validationResults ?? {};
    return {
      type,
      status: validation.status ?? (result.status === 200 ? 'PASS' : 'ERROR'),
      httpStatus: result.status,
      warnings: messagesOf(validation.warningMessages),
      errors: messagesOf(validation.errorMessages),
    };
  }

  private async recordError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await this.write({ lastError: message.slice(0, 1000) }).catch(() => undefined);
  }

  private asHttp(err: unknown) {
    if (err instanceof ZatcaApiError) return err.kind === 'TEMPORARY' ? new ServiceUnavailableException(err.message) : new BadRequestException(err.message);
    return err;
  }

  // ---------- the chain ----------

  /** Queues every invoice and credit note issued since switch-on that has no document yet. */
  async enrol() {
    const stored = await this.readAll();
    if (stored.enabled !== 'true' || !stored.activatedAt) return 0;
    const environment = this.environmentOf(stored);
    const since = new Date(stored.activatedAt);
    const [invoices, notes] = await Promise.all([
      this.prisma.invoice.findMany({ where: { issuedAt: { gte: since }, zatcaDocument: null }, select: { id: true, issuedAt: true }, orderBy: { number: 'asc' }, take: 500 }),
      this.prisma.creditNote.findMany({ where: { issuedAt: { gte: since }, zatcaDocument: null }, select: { id: true, issuedAt: true }, orderBy: { number: 'asc' }, take: 500 }),
    ]);
    const rows = [
      ...invoices.map((row) => ({ kind: 'INVOICE' as const, invoiceId: row.id, issuedAt: row.issuedAt })),
      ...notes.map((row) => ({ kind: 'CREDIT_NOTE' as const, creditNoteId: row.id, issuedAt: row.issuedAt })),
    ].sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime());
    // One by one so createdAt keeps issue order, which is the order they are chained in.
    for (const { issuedAt: _issued, ...row } of rows) {
      await this.prisma.zatcaDocument.createMany({ data: [{ ...row, environment, uuid: crypto.randomUUID() }], skipDuplicates: true });
    }
    return rows.length;
  }

  private async signingKey(stored: Record<string, string>) {
    if (stored.enabled !== 'true' || stored.stage !== 'PRODUCTION' || !stored.productionToken) return null;
    const privateKey = this.decrypt(stored.privateKey);
    if (!privateKey) return null;
    const body = certificateBody(stored.productionToken);
    return { privateKey, certificateBody: body, cert: certificateInfo(body) };
  }

  /**
   * Signs queued documents in order. The advisory lock makes this the only writer of the chain, so
   * each ICV is the previous plus one and each PIH is the hash of the document signed just before it.
   */
  async signPending() {
    const stored = await this.readAll();
    const key = await this.signingKey(stored);
    if (!key) return 0;
    const environment = this.environmentOf(stored);
    const seller = await this.sellerOf(stored);

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${CHAIN_LOCK})) AS lock`);
        const pending = await tx.zatcaDocument.findMany({
          where: { environment, signedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: SIGN_BATCH,
          include: {
            invoice: { include: { booking: { select: { payment: { select: { method: true } } } } } },
            creditNote: { include: { invoice: { select: { tripCode: true, number: true, seller: true, vatRate: true } } } },
          },
        });
        if (pending.length === 0) return 0;
        const last = await tx.zatcaDocument.findFirst({ where: { environment, icv: { not: null } }, orderBy: { icv: 'desc' }, select: { icv: true, invoiceHash: true } });
        let icv = last?.icv ?? 0;
        let previousHash = last?.invoiceHash ?? FIRST_PREVIOUS_HASH;
        for (const doc of pending) {
          icv += 1;
          const input = this.documentInput(doc, seller, icv, previousHash);
          const signed = signDocument(input, key);
          await tx.zatcaDocument.update({
            where: { id: doc.id },
            data: { icv, previousHash, invoiceHash: signed.hash, xml: signed.xml, qr: signed.qr, signedAt: new Date(), nextAttemptAt: new Date() },
          });
          previousHash = signed.hash;
        }
        return pending.length;
      },
      { maxWait: 30_000, timeout: 120_000 },
    );
  }

  private documentInput(doc: any, seller: Awaited<ReturnType<ZatcaService['sellerOf']>>, icv: number, previousHash: string): ZatcaDocumentInput {
    if (doc.kind === 'INVOICE') {
      const invoice = doc.invoice;
      return {
        kind: 'INVOICE',
        number: invoiceNumber(invoice.tripCode, invoice.number),
        uuid: doc.uuid,
        icv,
        previousHash,
        issuedAt: invoice.issuedAt,
        seller: this.zatcaSeller(seller, invoice.seller),
        buyerName: invoice.passengerName,
        lines: [{ name: `حجز رحلة ${invoice.tripCode} - ${invoice.destination}`, net: halalas(invoice.taxable), vat: halalas(invoice.vat) }],
        vatRate: Number(invoice.vatRate),
        paymentMeansCode: PAYMENT_MEANS[invoice.booking?.payment?.method ?? ''],
      };
    }
    const note = doc.creditNote;
    const original = invoiceNumber(note.invoice.tripCode, note.invoice.number);
    return {
      kind: 'CREDIT_NOTE',
      number: creditNoteNumber(note.tripCode, note.number),
      uuid: doc.uuid,
      icv,
      previousHash,
      issuedAt: note.issuedAt,
      seller: this.zatcaSeller(seller, note.invoice.seller),
      lines: [{ name: `استرداد من الفاتورة ${original}`, net: halalas(note.taxable), vat: halalas(note.vat) }],
      vatRate: Number(note.invoice.vatRate),
      billingReference: original,
      reason: note.reason || 'إلغاء أو استرداد حجز',
      paymentMeansCode: '10',
    };
  }

  /**
   * The phase-2 QR for printing, signing the invoice on the spot if the worker has not reached it yet.
   * Null whenever phase 2 does not apply, so the caller prints the phase-1 QR exactly as before.
   */
  async printableQr(invoiceId: string): Promise<string | null> {
    try {
      const existing = await this.prisma.zatcaDocument.findUnique({ where: { invoiceId }, select: { qr: true } });
      if (existing?.qr) return existing.qr;
      const stored = await this.readAll();
      if (stored.enabled !== 'true' || !stored.activatedAt) return null;
      const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { issuedAt: true } });
      if (!invoice || invoice.issuedAt < new Date(stored.activatedAt)) return null;
      if (!existing) await this.enrol();
      await this.signPending();
      return (await this.prisma.zatcaDocument.findUnique({ where: { invoiceId }, select: { qr: true } }))?.qr ?? null;
    } catch (err) {
      this.logger.error(`Could not sign invoice ${invoiceId} for printing: ${(err as Error).message}`);
      return null;
    }
  }

  // ---------- reporting ----------

  /** Sends signed documents to ZATCA. Keeps going while e-invoicing is paused: what was handed out signed must still be reported. */
  async reportDue() {
    const stored = await this.readAll();
    const environment = this.environmentOf(stored);
    const secret = this.decrypt(stored.productionSecret);
    if (stored.stage !== 'PRODUCTION' || !stored.productionToken || !secret) return 0;
    const waiting = await this.prisma.zatcaDocument.count({ where: { status: 'PENDING', signedAt: { not: null }, nextAttemptAt: { lte: new Date() } } });
    if (waiting === 0) return 0;

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "ZatcaDocument" SET "claimedAt" = NOW()
      WHERE "id" IN (
        SELECT "id" FROM "ZatcaDocument"
        WHERE "status" = 'PENDING' AND "signedAt" IS NOT NULL AND "nextAttemptAt" <= NOW()
          AND ("claimedAt" IS NULL OR "claimedAt" < ${new Date(Date.now() - STALE_CLAIM_MS)})
        ORDER BY "icv" ASC
        LIMIT ${REPORT_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    if (rows.length === 0) return 0;
    const docs = await this.prisma.zatcaDocument.findMany({ where: { id: { in: rows.map((row) => row.id) } }, orderBy: { icv: 'asc' } });
    const auth = { token: stored.productionToken, secret };
    const client = this.client(environment);

    for (const [index, doc] of docs.entries()) {
      if (doc.environment !== environment) {
        await this.prisma.zatcaDocument.update({ where: { id: doc.id }, data: { status: 'FAILED', claimedAt: null, errorMessage: 'وُقّع في بيئة أخرى غير البيئة الحالية' } });
        continue;
      }
      try {
        const result = await client.report(auth, { hash: doc.invoiceHash!, uuid: doc.uuid, xml: doc.xml! });
        await this.prisma.zatcaDocument.update({ where: { id: doc.id }, data: this.reportOutcome(result, doc.attempts) });
      } catch (err) {
        const failure = err instanceof ZatcaApiError ? err : new ZatcaApiError((err as Error).message, 'TEMPORARY');
        const attempts = doc.attempts + 1;
        if (failure.kind === 'AUTH') {
          // Every document would fail the same way; wait and tell the admin.
          await this.prisma.zatcaDocument.updateMany({
            where: { id: { in: docs.slice(index).map((row) => row.id) } },
            data: { claimedAt: null, nextAttemptAt: new Date(Date.now() + AUTH_WAIT_MS), errorMessage: failure.message },
          });
          await this.recordError(failure);
          this.logger.warn(`ZATCA reporting paused: ${failure.message}`);
          return index;
        }
        const giveUp = failure.kind === 'REJECTED' || attempts >= MAX_ATTEMPTS;
        await this.prisma.zatcaDocument.update({
          where: { id: doc.id },
          data: {
            status: giveUp ? (failure.kind === 'REJECTED' ? 'REJECTED' : 'FAILED') : 'PENDING',
            attempts,
            claimedAt: null,
            nextAttemptAt: new Date(Date.now() + Math.min(BASE_RETRY_MS * 2 ** attempts, MAX_RETRY_MS)),
            errorMessage: failure.message,
            response: (failure.body ?? Prisma.DbNull) as Prisma.InputJsonValue,
          },
        });
      }
    }
    return docs.length;
  }

  private reportOutcome(result: ZatcaSubmitResult, attempts: number): Prisma.ZatcaDocumentUpdateInput {
    const validation = result.body?.validationResults ?? {};
    const warnings = messagesOf(validation.warningMessages);
    const errors = messagesOf(validation.errorMessages);
    const base = { attempts: attempts + 1, claimedAt: null, response: result.body as Prisma.InputJsonValue };
    if (result.status === 400) return { ...base, status: 'REJECTED', errorMessage: errors.join(' | ') || 'رفضت المنصة المستند' };
    // 409: ZATCA already has this document, which is what we wanted.
    const status: ZatcaStatus = result.status === 202 || warnings.length > 0 || result.status === 409 ? 'WARNING' : 'REPORTED';
    return { ...base, status, reportedAt: new Date(), errorMessage: warnings.join(' | ') || null };
  }

  /** One pass of the worker. */
  async sweep() {
    const enrolled = await this.enrol();
    const signed = await this.signPending();
    const reported = await this.reportDue();
    return { enrolled, signed, reported };
  }

  // ---------- documents ----------

  async documents(query: ZatcaDocumentsQuery) {
    const where: Prisma.ZatcaDocumentWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.kind && { kind: query.kind }),
      ...(query.search && {
        OR: [
          { invoice: { passengerName: { contains: query.search, mode: 'insensitive' } } },
          { invoice: { tripCode: { contains: query.search, mode: 'insensitive' } } },
          { creditNote: { tripCode: { contains: query.search, mode: 'insensitive' } } },
          { uuid: query.search },
        ],
      }),
    };
    const page = query.page ?? 1;
    const [rows, total] = await Promise.all([
      this.prisma.zatcaDocument.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          kind: true,
          environment: true,
          uuid: true,
          icv: true,
          status: true,
          attempts: true,
          errorMessage: true,
          signedAt: true,
          reportedAt: true,
          createdAt: true,
          nextAttemptAt: true,
          invoice: { select: { bookingId: true, tripCode: true, number: true, passengerName: true, total: true, vat: true, issuedAt: true } },
          creditNote: { select: { bookingId: true, tripCode: true, number: true, total: true, vat: true, issuedAt: true } },
        },
      }),
      this.prisma.zatcaDocument.count({ where }),
    ]);
    const now = Date.now();
    return {
      items: rows.map((row) => {
        const source = row.invoice ?? row.creditNote;
        return {
          id: row.id,
          kind: row.kind,
          environment: row.environment,
          number: row.invoice ? invoiceNumber(row.invoice.tripCode, row.invoice.number) : row.creditNote ? creditNoteNumber(row.creditNote.tripCode, row.creditNote.number) : '',
          bookingId: source?.bookingId ?? null,
          passengerName: row.invoice?.passengerName ?? null,
          total: Number(source?.total ?? 0),
          vat: Number(source?.vat ?? 0),
          issuedAt: source?.issuedAt ?? row.createdAt,
          uuid: row.uuid,
          icv: row.icv,
          status: row.status,
          signed: !!row.signedAt,
          attempts: row.attempts,
          errorMessage: row.errorMessage,
          reportedAt: row.reportedAt,
          nextAttemptAt: row.status === 'PENDING' ? row.nextAttemptAt : null,
          overdue: row.status === 'PENDING' && now - (source?.issuedAt ?? row.createdAt).getTime() > REPORT_DEADLINE_MS,
        };
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  /** Puts a document back in the queue. A signed document is resent as it is: re-signing would break the chain. */
  async retry(id: string) {
    const doc = await this.prisma.zatcaDocument.findUnique({ where: { id }, select: { status: true } });
    if (!doc) throw new NotFoundException('المستند غير موجود');
    if (doc.status === 'REPORTED') throw new BadRequestException('أُبلغ عن هذا المستند بالفعل');
    await this.prisma.zatcaDocument.update({ where: { id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), claimedAt: null } });
    // Report right away rather than waiting for the next pass; a failure stays on the row.
    await this.signPending().catch(() => 0);
    await this.reportDue().catch((err) => this.logger.error(`ZATCA retry failed: ${err.message}`));
    const after = await this.prisma.zatcaDocument.findUnique({ where: { id }, select: { status: true, errorMessage: true, attempts: true } });
    return after;
  }

  async xml(id: string) {
    const doc = await this.prisma.zatcaDocument.findUnique({
      where: { id },
      select: { xml: true, uuid: true, invoice: { select: { tripCode: true, number: true } }, creditNote: { select: { tripCode: true, number: true } } },
    });
    if (!doc) throw new NotFoundException('المستند غير موجود');
    if (!doc.xml) throw new BadRequestException('لم يُوقّع هذا المستند بعد');
    const number = doc.invoice ? invoiceNumber(doc.invoice.tripCode, doc.invoice.number) : doc.creditNote ? creditNoteNumber(doc.creditNote.tripCode, doc.creditNote.number) : doc.uuid;
    return { fileName: `${number}.xml`, xml: doc.xml };
  }

  /** ZATCA state per invoice for the register, or an empty map when phase 2 has never been used. */
  async statusByInvoice(invoiceIds: string[]) {
    if (invoiceIds.length === 0) return new Map<string, ZatcaStatus>();
    const rows = await this.prisma.zatcaDocument.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { invoiceId: true, status: true } });
    return new Map(rows.map((row) => [row.invoiceId!, row.status]));
  }
}
