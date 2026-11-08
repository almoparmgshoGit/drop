/** Editable under settings. They appear on every printed invoice, so the public settings endpoint exposes nothing private. */
export const INVOICE_SETTING_DEFAULTS = {
  sellerName: 'دروب الهجرة',
  sellerTagline: 'رفيقك في السفر أينما كنت',
  // Left empty on purpose: a wrong number would be frozen onto real tax invoices.
  vatNumber: '',
  crNumber: '',
  sellerCity: 'ينبع - المملكة العربية السعودية',
  invoiceContacts: '',
  invoiceTripNotice: 'تنبيه: الباص سوف يتحرك في موعده، أي تأخير يتحمله العميل ولا يحق له استرداد مبلغ التذكرة',
  invoiceFooter: 'احتفظ بالتذكرة وأبرزها عند الصعود إلى الباص',
};

export type InvoiceSettings = typeof INVOICE_SETTING_DEFAULTS;

const pad = (value: number) => String(value).padStart(4, '0');

export const invoiceNumber = (tripCode: string, number: number) => `INV-${tripCode}-${pad(number)}`;
export const creditNoteNumber = (tripCode: string, number: number) => `CN-${tripCode}-${pad(number)}`;

/** VAT inside a tax-inclusive amount, in halalas. */
export const vatInside = (grossHalalas: number, rate: number) => Math.round((grossHalalas * rate) / (100 + rate));

/**
 * The QR the tax authority requires on a simplified invoice: seller, VAT number, time, total and VAT
 * as tag-length-value fields, base64 encoded. Lengths count bytes, because Arabic takes two per letter.
 */
export function zatcaQr(fields: { seller: string; vatNumber: string; issuedAt: Date; total: number; vat: number }) {
  const values = [
    fields.seller,
    fields.vatNumber,
    fields.issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    fields.total.toFixed(2),
    fields.vat.toFixed(2),
  ];
  return Buffer.concat(
    values.map((value, index) => {
      const bytes = Buffer.from(value, 'utf8');
      return Buffer.concat([Buffer.from([index + 1, bytes.length]), bytes]);
    }),
  ).toString('base64');
}

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const ONES_FEMININE = ['', 'واحدة', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثماني', 'تسع', 'عشر', 'إحدى عشرة', 'اثنتا عشرة', 'ثلاث عشرة', 'أربع عشرة', 'خمس عشرة', 'ست عشرة', 'سبع عشرة', 'ثماني عشرة', 'تسع عشرة'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

const belowThousand = (value: number, feminine = false) => {
  const ones = feminine ? ONES_FEMININE : ONES;
  const rest = value % 100;
  const parts = [HUNDREDS[Math.floor(value / 100)]];
  if (rest < 20) parts.push(ones[rest]);
  else parts.push(rest % 10 ? `${rest % 10 === 1 && feminine ? 'إحدى' : ones[rest % 10]} و${TENS[Math.floor(rest / 10)]}` : TENS[Math.floor(rest / 10)]);
  return parts.filter(Boolean).join(' و');
};

const scale = (count: number, one: string, two: string, few: string) => {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count <= 10) return `${belowThousand(count)} ${few}`;
  return `${belowThousand(count)} ${one}`;
};

const wholeInWords = (value: number) => {
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1000);
  const rest = value % 1000;
  return [
    millions && scale(millions, 'مليون', 'مليونان', 'ملايين'),
    thousands && scale(thousands, 'ألف', 'ألفان', 'آلاف'),
    rest && belowThousand(rest),
  ].filter(Boolean).join(' و');
};

/** Arabic takes the noun in a different form depending on the last two digits of the count. */
const counted = (value: number, words: string, forms: { one: string; two: string; few: string; many: string; hundred: string }) => {
  if (value === 1) return forms.one;
  if (value === 2) return forms.two;
  const lastTwo = value % 100;
  if (lastTwo >= 3 && lastTwo <= 10) return `${words} ${forms.few}`;
  if (lastTwo >= 11) return `${words} ${forms.many}`;
  return `${words} ${forms.hundred}`;
};

/** "خمسون ريالًا فقط لا غير", printed on invoices the way the amount is written on a cheque. */
export function amountInWords(amount: number) {
  const halalas = Math.round(amount * 100);
  const riyals = Math.floor(halalas / 100);
  const cents = halalas % 100;
  const riyalPart = counted(riyals, wholeInWords(riyals), { one: 'ريال واحد', two: 'ريالان', few: 'ريالات', many: 'ريالًا', hundred: 'ريال' });
  const centPart = counted(cents, belowThousand(cents, true), { one: 'هللة واحدة', two: 'هللتان', few: 'هللات', many: 'هللة', hundred: 'هللة' });
  if (riyals === 0 && cents === 0) return 'صفر ريال';
  return `${[riyals > 0 && riyalPart, cents > 0 && centPart].filter(Boolean).join(' و')} فقط لا غير`;
}
