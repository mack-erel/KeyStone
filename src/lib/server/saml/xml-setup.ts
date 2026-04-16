/**
 * xmldsigjs 엔진 초기화.
 * Cloudflare Workers 에는 DOMParser/XMLSerializer/xpath 가 전역으로 없으므로
 * @xmldom/xmldom 구현체를 xml-core 에 등록하고 Workers WebCrypto 를 엔진으로 주입.
 *
 * 모듈 로드 시 한 번만 실행되도록 플래그로 보호.
 */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { setNodeDependencies } from 'xml-core';
import * as xmldsigjs from 'xmldsigjs';

let initialized = false;

export function ensureXmlEngine(): void {
	if (initialized) return;
	setNodeDependencies({ DOMParser, XMLSerializer, xpath });
	xmldsigjs.Application.setEngine('WorkersWebCrypto', crypto as unknown as Crypto);
	initialized = true;
}

export { DOMParser, XMLSerializer, xmldsigjs };
