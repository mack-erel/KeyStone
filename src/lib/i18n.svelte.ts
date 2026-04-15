import { untrack } from 'svelte';
import ko from './i18n/ko.json';

export type Locale = 'ko';

type Messages = typeof ko;

const messages: Record<Locale, Messages> = {
  ko
};

let currentLocale = $state<Locale>('ko');

export function setLocale(locale: Locale) {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const locale = getLocale();
  const keys = key.split('.');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let message: any = messages[locale];

  for (const k of keys) {
    if (message && typeof message === 'object' && k in message) {
      message = message[k];
    } else {
      return key;
    }
  }

  if (typeof message !== 'string') {
    return key;
  }

  if (!params) {
    return message;
  }

  return message.replace(/{{(.*?)}}/g, (_, param) => {
    const trimmedParam = param.trim();
    return params[trimmedParam]?.toString() ?? `{{${trimmedParam}}}`;
  });
}
