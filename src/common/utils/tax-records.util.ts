/**
 * Issued tax invoices and credit notes are never deleted (ZATCA e-invoicing). Only the client's trial database and a
 * developer's machine may still wipe them, so trial data can be cleared before launch. Once CLIENT_TRIAL_MODE is turned off
 * on the live server, nothing removes them: deleting a trip or resetting the system refuses instead.
 */
export const taxRecordsDeletable = () => process.env.CLIENT_TRIAL_MODE === 'true' || process.env.NODE_ENV !== 'production';

export const TAX_RECORDS_KEPT_MESSAGE = 'عليها فواتير ضريبية أو إشعارات دائن، وهذه لا تُحذف من النظام حفاظًا على الأثر المحاسبي';
