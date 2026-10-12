import { test, expect, describe } from 'bun:test';
import { isExtensionPageSender } from '../src/lib/sender-trust';

const EXT = 'abcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT}`;

describe('isExtensionPageSender', () => {
  test('accepts any of our own pages when no page list is given', () => {
    expect(isExtensionPageSender({ id: EXT, url: `${ORIGIN}/popup.html` }, EXT)).toBe(true);
    expect(isExtensionPageSender({ id: EXT, url: `${ORIGIN}/swap.html?x=1` }, EXT)).toBe(true);
  });

  test('accepts only the listed pages when a page list is given', () => {
    const confirmOnly = ['confirm.html'];
    expect(isExtensionPageSender({ id: EXT, url: `${ORIGIN}/confirm.html?id=42` }, EXT, confirmOnly)).toBe(true);
    expect(isExtensionPageSender({ id: EXT, url: `${ORIGIN}/popup.html` }, EXT, confirmOnly)).toBe(false);
  });

  test('rejects content scripts (same extension id, but a web page URL)', () => {
    expect(isExtensionPageSender({ id: EXT, url: 'https://evil.example/confirm.html' }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: EXT, url: 'https://evil.example/', tab: { id: 3 } } as chrome.runtime.MessageSender, EXT)).toBe(false);
  });

  test('rejects other extensions and missing data', () => {
    expect(isExtensionPageSender({ id: 'other', url: `chrome-extension://other/popup.html` }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: EXT, url: `chrome-extension://other/popup.html` }, EXT)).toBe(false);
    expect(isExtensionPageSender({ id: EXT }, EXT)).toBe(false);
    expect(isExtensionPageSender({ url: `${ORIGIN}/popup.html` }, EXT)).toBe(false);
  });

  test('page match is on the exact path, not a prefix', () => {
    const confirmOnly = ['confirm.html'];
    expect(isExtensionPageSender({ id: EXT, url: `${ORIGIN}/confirm.html.evil` }, EXT, confirmOnly)).toBe(false);
    expect(isExtensionPageSender({ id: EXT, url: `${ORIGIN}/x/confirm.html` }, EXT, confirmOnly)).toBe(false);
  });
});
