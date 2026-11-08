import { BadRequestException } from '@nestjs/common';
import { MESSAGE_LANGUAGES, MessageLanguage } from './notification-catalog';

export type Wording = { title: string; body: string };
export type LanguageWordings = Partial<Record<MessageLanguage, Wording>>;

export const LANGUAGE_NAMES: Record<MessageLanguage, string> = { ar: 'العربية', en: 'الإنجليزية', ur: 'الأردية' };

export const isMessageLanguage = (value: unknown): value is MessageLanguage => typeof value === 'string' && (MESSAGE_LANGUAGES as readonly string[]).includes(value);

/** Reads a stored { lang: { title, body } } column, keeping only complete wordings in a known language. */
export function readWordings(json: unknown): LanguageWordings {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const result: LanguageWordings = {};
  for (const [language, value] of Object.entries(json as Record<string, unknown>)) {
    if (!isMessageLanguage(language) || !value || typeof value !== 'object') continue;
    const { title, body } = value as Record<string, unknown>;
    if (typeof title === 'string' && typeof body === 'string' && title.trim() && body.trim()) result[language] = { title: title.trim(), body: body.trim() };
  }
  return result;
}

/**
 * Checks the wording a sender typed for each language they chose: every chosen language needs a title and a body
 * within the limits, and a wording for a language that was not chosen is dropped.
 */
export function requireWordings(languages: MessageLanguage[], content: unknown, limits: { title: number; body: number }): LanguageWordings {
  const typed = (content && typeof content === 'object' ? content : {}) as Record<string, { title?: unknown; body?: unknown } | undefined>;
  const result: LanguageWordings = {};
  for (const language of languages) {
    const title = typeof typed[language]?.title === 'string' ? (typed[language]!.title as string).trim() : '';
    const body = typeof typed[language]?.body === 'string' ? (typed[language]!.body as string).trim() : '';
    if (!title || !body) throw new BadRequestException(`اكتب العنوان والنص باللغة ${LANGUAGE_NAMES[language]}`);
    if (title.length > limits.title) throw new BadRequestException(`العنوان باللغة ${LANGUAGE_NAMES[language]} لا يتجاوز ${limits.title} حرفًا`);
    if (body.length > limits.body) throw new BadRequestException(`النص باللغة ${LANGUAGE_NAMES[language]} لا يتجاوز ${limits.body} حرف`);
    result[language] = { title, body };
  }
  return result;
}

/**
 * The wordings of a message staff typed. A request with only title and body (the form before languages existed)
 * is one Arabic wording that everyone receives.
 */
export function typedWordings(languages: MessageLanguage[], dto: { content?: unknown; title?: string; body?: string }, limits: { title: number; body: number }): LanguageWordings {
  if (dto.content !== undefined && dto.content !== null) return requireWordings(languages, dto.content, limits);
  return requireWordings(['ar'], { ar: { title: dto.title, body: dto.body } }, limits);
}

/** The chosen languages in a fixed order without repeats; none chosen means all of them. */
export function normalizeLanguages(languages?: string[] | null): MessageLanguage[] {
  const chosen = new Set((languages ?? []).filter(isMessageLanguage));
  return chosen.size === 0 ? [...MESSAGE_LANGUAGES] : MESSAGE_LANGUAGES.filter((language) => chosen.has(language));
}

export const isEveryLanguage = (languages: MessageLanguage[]) => languages.length === MESSAGE_LANGUAGES.length;
