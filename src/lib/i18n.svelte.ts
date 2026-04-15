import ko from './i18n/ko.json';

export type Locale = 'ko';

type Messages = typeof ko;

interface MessageDictionary {
	[key: string]: string | MessageDictionary;
}

type MessageValue = string | MessageDictionary;

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

	let message: MessageValue = messages[locale] as MessageValue;

	for (const currentKey of keys) {
		if (typeof message === 'object' && message !== null && currentKey in message) {
			message = message[currentKey];
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

	return message.replace(/{{(.*?)}}/g, (_, param: string) => {
		const trimmedParam = param.trim();
		return params[trimmedParam]?.toString() ?? `{{${trimmedParam}}}`;
	});
}
