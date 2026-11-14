/** The three Fatoora gateways. Each has its own certificates and its own invoice chain. */
export const ZATCA_ENVIRONMENTS = {
  'developer-portal': { label: 'بيئة المطورين (Sandbox)', template: 'TSTZATCA-Code-Signing' },
  simulation: { label: 'بيئة المحاكاة (Simulation)', template: 'PREZATCA-Code-Signing' },
  core: { label: 'بيئة الإنتاج (Production)', template: 'ZATCA-Code-Signing' },
} as const;

export type ZatcaEnvironment = keyof typeof ZATCA_ENVIRONMENTS;

export const isZatcaEnvironment = (value: unknown): value is ZatcaEnvironment => typeof value === 'string' && value in ZATCA_ENVIRONMENTS;

const DEFAULT_BASE = 'https://gw-fatoora.zatca.gov.sa/e-invoicing';
const TIMEOUT_MS = 30_000;

/** AUTH: the certificate or secret was refused; REJECTED: the document itself failed; TEMPORARY: try again later. */
export type ZatcaErrorKind = 'AUTH' | 'REJECTED' | 'TEMPORARY';

export class ZatcaApiError extends Error {
  constructor(
    message: string,
    readonly kind: ZatcaErrorKind,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export type ZatcaValidation = {
  status?: string;
  infoMessages?: unknown[];
  warningMessages?: { code?: string; message?: string }[];
  errorMessages?: { code?: string; message?: string }[];
};

export type ZatcaSubmitResult = { status: number; body: { validationResults?: ZatcaValidation; reportingStatus?: string; clearanceStatus?: string; [key: string]: unknown } };

export type ZatcaCsid = { requestID?: number | string; binarySecurityToken: string; secret: string; dispositionMessage?: string };

/**
 * Talks to ZATCA's Fatoora API (version 2). The base URL can be replaced through ZATCA_API_BASE_URL,
 * which is how tests point it at a stub; nothing here runs unless an admin starts onboarding or
 * switches e-invoicing on.
 */
export class ZatcaApiClient {
  constructor(
    private environment: ZatcaEnvironment,
    private baseOverride?: string,
  ) {}

  get baseUrl() {
    return `${(this.baseOverride || DEFAULT_BASE).replace(/\/$/, '')}/${this.environment}`;
  }

  private async request(path: string, init: { method: string; headers?: Record<string, string>; body?: unknown; auth?: { token: string; secret: string } }) {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Version': 'V2', 'Accept-Language': 'en', ...init.headers };
    if (init.auth) headers.Authorization = `Basic ${Buffer.from(`${init.auth.token}:${init.auth.secret}`).toString('base64')}`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new ZatcaApiError(`تعذر الاتصال بمنصة فاتورة: ${(err as Error).message}`, 'TEMPORARY');
    }
    const text = await response.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Some gateway errors come back as plain text or HTML.
    }
    return { status: response.status, body };
  }

  private fail(status: number, body: any, fallback: string): never {
    const messages = [
      ...(body?.validationResults?.errorMessages ?? []),
      ...(Array.isArray(body?.errors) ? body.errors : []),
    ]
      .map((item: any) => (typeof item === 'string' ? item : [item?.code, item?.message].filter(Boolean).join(': ')))
      .filter(Boolean);
    const detail = messages.join(' | ') || (typeof body === 'string' ? body.slice(0, 300) : body?.message) || fallback;
    const kind: ZatcaErrorKind = status === 401 || status === 403 ? 'AUTH' : status === 429 || status >= 500 ? 'TEMPORARY' : 'REJECTED';
    throw new ZatcaApiError(`${fallback} (${status}): ${detail}`, kind, status, body);
  }

  /** Step 1: the CSR and the one-time code from the Fatoora portal give the compliance certificate. */
  async complianceCsid(csrPem: string, otp: string): Promise<ZatcaCsid> {
    const { status, body } = await this.request('/compliance', { method: 'POST', headers: { OTP: otp }, body: { csr: Buffer.from(csrPem).toString('base64') } });
    if (status !== 200 || !body?.binarySecurityToken) this.fail(status, body, 'رفضت المنصة طلب شهادة الامتثال');
    return body;
  }

  /** Step 2: sample documents signed with the compliance certificate. */
  async complianceInvoice(auth: { token: string; secret: string }, document: { hash: string; uuid: string; xml: string }): Promise<ZatcaSubmitResult> {
    const { status, body } = await this.request('/compliance/invoices', {
      method: 'POST',
      auth,
      body: { invoiceHash: document.hash, uuid: document.uuid, invoice: Buffer.from(document.xml, 'utf8').toString('base64') },
    });
    if (status !== 200 && status !== 202 && status !== 400) this.fail(status, body, 'تعذر فحص الامتثال');
    return { status, body };
  }

  /** Step 3: the production certificate, against the compliance request that passed. */
  async productionCsid(auth: { token: string; secret: string }, complianceRequestId: string): Promise<ZatcaCsid> {
    const { status, body } = await this.request('/production/csids', { method: 'POST', auth, body: { compliance_request_id: complianceRequestId } });
    if (status !== 200 || !body?.binarySecurityToken) this.fail(status, body, 'رفضت المنصة طلب شهادة الإنتاج');
    return body;
  }

  /** A simplified invoice or note, within 24 hours of issue. 200 reported, 202 reported with warnings, 400 rejected. */
  async report(auth: { token: string; secret: string }, document: { hash: string; uuid: string; xml: string }): Promise<ZatcaSubmitResult> {
    const { status, body } = await this.request('/invoices/reporting/single', {
      method: 'POST',
      auth,
      headers: { 'Clearance-Status': '0' },
      body: { invoiceHash: document.hash, uuid: document.uuid, invoice: Buffer.from(document.xml, 'utf8').toString('base64') },
    });
    if (status === 200 || status === 202 || status === 400 || status === 409) return { status, body };
    this.fail(status, body, 'تعذر إبلاغ المنصة بالفاتورة');
  }
}
