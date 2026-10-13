// Relay credentials stay in the service worker. The popup_request router
// accepts these requests only from our own extension pages.
declare const __RELAY_API_KEY__: string;

export async function relayRequest(payload: unknown): Promise<unknown> {
  if (typeof payload !== 'object' || payload === null) throw new Error('Invalid Relay request');
  const { method, path, body } = payload as Record<string, unknown>;
  const allowed = (method === 'GET' && path === '/chains')
    || (method === 'POST' && path === '/quote/v2')
    || (method === 'GET' && typeof path === 'string' && /^\/intents\/status\/v3\?requestId=[A-Za-z0-9%_-]+$/.test(path));
  if (!allowed) throw new Error('Unsupported Relay endpoint or method');
  if (method === 'POST' && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    throw new Error('Invalid Relay quote body');
  }
  if (method === 'GET' && body !== undefined) throw new Error('Relay GET request cannot have a body');

  const apiKey = typeof __RELAY_API_KEY__ === 'string' ? __RELAY_API_KEY__.trim() : '';
  if (apiKey === '') throw new Error('Relay API key is not configured. Set RELAY_API_KEY and rebuild the extension.');
  const headers: Record<string, string> = { 'x-api-key': apiKey };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  // This is the external API boundary: redact credentials from HTTP, network,
  // and JSON errors before the message router sends them back to the UI.
  try {
    const response = await fetch(`https://api.relay.link${path}`, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
    const text = (await response.text()).replaceAll(apiKey, '[redacted]');
    if (!response.ok) {
      let detail = text.trim();
      if (response.headers.get('content-type')?.includes('application/json') && detail !== '') {
        const error: unknown = JSON.parse(text);
        if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
          detail = error.message;
        }
      }
      throw new Error(`Relay ${path} HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
    }
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(apiKey, '[redacted]'));
  }
}
