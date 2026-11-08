import { Injectable } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';

const DEFAULT_API_URL = 'https://graph.facebook.com/v23.0';
const REQUEST_TIMEOUT_MS = 10_000;
/** Meta's codes for a number that cannot receive the message: trying again changes nothing. */
const RECIPIENT_ERRORS = new Set([131026, 131021, 131050, 131008, 131009, 130472]);
/** The template no longer exists or no longer matches what is sent. */
const TEMPLATE_ERRORS = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
/** The account's token or permissions: every message would fail the same way, so the queue waits. */
const ACCOUNT_ERRORS = new Set([0, 3, 10, 190, 200, 368, 131031, 131045]);

export type SendFailure = 'RECIPIENT' | 'TEMPLATE' | 'ACCOUNT' | 'TEMPORARY';

/** Its message is written for the panel, and never carries the token or Meta's raw reply. */
export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly kind: SendFailure,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface SubmittedTemplate {
  name: string;
  language: string;
  category: string;
  body: string;
  examples: string[];
}

const ERROR_MESSAGES: Record<SendFailure, string> = {
  RECIPIENT: 'الرقم غير متاح على واتساب',
  TEMPLATE: 'القالب غير معتمد أو لا يطابق ما أُرسل',
  ACCOUNT: 'رفضت Meta الطلب: تأكد من رمز الوصول وصلاحياته وحالة الحساب',
  TEMPORARY: 'تعذر الإرسال مؤقتًا',
};

/** Meta takes the number's digits with the country code and no plus sign. */
export const toWhatsAppNumber = (phone: string) => phone.replace(/\D/g, '');

/** The only code that talks to Meta. Keys are read on each use, so a change in the panel applies at once. */
@Injectable()
export class WhatsAppService {
  constructor(private integrations: IntegrationsService) {}

  private async keys() {
    const [apiUrl, phoneId, businessId, token] = await Promise.all([
      this.integrations.value('whatsappApiUrl'),
      this.integrations.value('whatsappPhoneId'),
      this.integrations.value('whatsappBusinessAccountId'),
      this.integrations.value('whatsappToken'),
    ]);
    return { apiUrl: apiUrl ?? DEFAULT_API_URL, phoneId, businessId, token };
  }

  async isConfigured() {
    const { phoneId, token } = await this.keys();
    return !!phoneId && !!token;
  }

  /** Login codes need their own Authentication template on top of the account's keys. */
  async isOtpConfigured() {
    const [configured, template] = await Promise.all([this.isConfigured(), this.integrations.value('whatsappOtpTemplate')]);
    return configured && !!template;
  }

  /**
   * Sends a login code through the account's Authentication template. Meta fixes that template's wording,
   * and its copy-code button carries the code a second time, so both parameters are the code.
   */
  async sendOtp(phone: string, code: string) {
    const [{ apiUrl, phoneId, token }, template, language] = await Promise.all([
      this.keys(),
      this.integrations.value('whatsappOtpTemplate'),
      this.integrations.value('whatsappOtpLanguage'),
    ]);
    if (!phoneId || !token || !template) throw new WhatsAppError('لم يكتمل ربط رمز الدخول بواتساب', 'ACCOUNT');
    const body = await this.call(`${apiUrl}/${encodeURIComponent(phoneId)}/messages`, token, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toWhatsAppNumber(phone),
        type: 'template',
        template: {
          name: template,
          language: { code: language ?? 'ar' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
    });
    const messageId: unknown = body?.messages?.[0]?.id;
    if (typeof messageId !== 'string') throw new WhatsAppError('ردت Meta برد غير متوقع', 'TEMPORARY');
    return messageId;
  }

  private async call(url: string, token: string, init: RequestInit = {}) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        // Meta's host is fixed by the settings pattern, and a redirect must not carry the token somewhere else.
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new WhatsAppError('تعذر الوصول إلى Meta، حاول مرة أخرى', 'TEMPORARY');
    }
    const body: any = await res.json().catch(() => null);
    if (res.ok) return body;
    const code: number | undefined = body?.error?.code;
    const kind: SendFailure =
      code !== undefined && RECIPIENT_ERRORS.has(code) ? 'RECIPIENT'
        : code !== undefined && TEMPLATE_ERRORS.has(code) ? 'TEMPLATE'
          : res.status === 401 || res.status === 403 || (code !== undefined && ACCOUNT_ERRORS.has(code)) ? 'ACCOUNT'
            : 'TEMPORARY';
    throw new WhatsAppError(ERROR_MESSAGES[kind], kind, code);
  }

  async sendTemplate(phone: string, templateName: string, language: string, params: string[]) {
    const { apiUrl, phoneId, token } = await this.keys();
    if (!phoneId || !token) throw new WhatsAppError('لم يكتمل ربط واتساب', 'ACCOUNT');
    const body = await this.call(`${apiUrl}/${encodeURIComponent(phoneId)}/messages`, token, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toWhatsAppNumber(phone),
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          ...(params.length > 0 && { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] }),
        },
      }),
    });
    const messageId: unknown = body?.messages?.[0]?.id;
    if (typeof messageId !== 'string') throw new WhatsAppError('ردت Meta برد غير متوقع', 'TEMPORARY');
    return messageId;
  }

  /** Reads the number's details, so a wrong key shows up before anyone relies on the connection. */
  async test() {
    const { apiUrl, phoneId, token } = await this.keys();
    if (!phoneId || !token) throw new WhatsAppError('أدخل معرّف الرقم ورمز الوصول أولًا', 'ACCOUNT');
    const body = await this.call(`${apiUrl}/${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name,quality_rating`, token);
    return {
      displayPhone: typeof body?.display_phone_number === 'string' ? body.display_phone_number : null,
      verifiedName: typeof body?.verified_name === 'string' ? body.verified_name : null,
      quality: typeof body?.quality_rating === 'string' ? body.quality_rating : null,
    };
  }

  async submitTemplate(template: SubmittedTemplate) {
    const { apiUrl, businessId, token } = await this.keys();
    if (!businessId || !token) throw new WhatsAppError('أدخل معرّف حساب الأعمال ورمز الوصول أولًا', 'ACCOUNT');
    const body = await this.call(`${apiUrl}/${encodeURIComponent(businessId)}/message_templates`, token, {
      method: 'POST',
      body: JSON.stringify({
        name: template.name,
        language: template.language,
        category: template.category,
        components: [{ type: 'BODY', text: template.body, ...(template.examples.length > 0 && { example: { body_text: [template.examples] } }) }],
      }),
    });
    return { metaId: typeof body?.id === 'string' ? body.id : null, status: typeof body?.status === 'string' ? body.status : 'PENDING' };
  }

  /** Every template on the account, as Meta currently sees them. */
  async listTemplates() {
    const { apiUrl, businessId, token } = await this.keys();
    if (!businessId || !token) throw new WhatsAppError('أدخل معرّف حساب الأعمال ورمز الوصول أولًا', 'ACCOUNT');
    const rows: { id?: string; name?: string; language?: string; status?: string; rejected_reason?: string }[] = [];
    let url: string | null = `${apiUrl}/${encodeURIComponent(businessId)}/message_templates?fields=id,name,language,status,rejected_reason&limit=200`;
    // A hard stop, because the next page's address comes from the reply.
    for (let page = 0; url && page < 20; page++) {
      const body: any = await this.call(url, token);
      rows.push(...(Array.isArray(body?.data) ? body.data : []));
      const next: unknown = body?.paging?.next;
      url = typeof next === 'string' && next.startsWith(`${apiUrl}/`) ? next : null;
    }
    return rows;
  }
}
