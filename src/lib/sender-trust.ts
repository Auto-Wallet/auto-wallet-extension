// Pure checks on chrome.runtime.MessageSender.
//
// Content scripts share our extension id, so `sender.id` alone does not prove a
// message came from one of our own pages. The URL does: a content script's
// sender.url is the web page it runs in, while our pages live under
// chrome-extension://<id>/.

/**
 * True when the message came from one of this extension's own pages. Pass
 * `pages` (e.g. ['confirm.html']) to accept only those exact paths.
 */
export function isExtensionPageSender(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'>,
  extensionId: string,
  pages?: readonly string[],
): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'chrome-extension:' || url.host !== extensionId) return false;
  if (!pages) return true;
  return pages.some((page) => url.pathname === `/${page}`);
}
