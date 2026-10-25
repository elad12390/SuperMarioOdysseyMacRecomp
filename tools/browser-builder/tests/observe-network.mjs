// Observe HTTP metadata from the page and its dedicated workers. Never request
// or retain POST bodies, key contents, cookies, or query-string values.
export async function observeBrowserNetwork(browser, origin) {
  const requests = [], errors = [], attached = new Set(), pending = new Set();
  const attach = target => {
    if (attached.has(target) || !['page', 'other', 'worker', 'service_worker'].includes(target.type())) return;
    attached.add(target);
    const promise = (async () => {
      try {
        const session = await target.createCDPSession();
        session.on('Network.requestWillBeSent', event => {
          const url = new URL(event.request.url);
          if (!['http:', 'https:'].includes(url.protocol)) return;
          requests.push({ target: target.type(), method: event.request.method,
            origin: url.origin, path: url.origin === origin ? url.pathname : '<external path omitted>',
            queryLength: url.search.length, bodyPresent: Boolean(event.request.hasPostData) });
        });
        await session.send('Network.enable');
      } catch (error) {
        if (!/closed|destroyed|No target|No session/i.test(String(error))) errors.push(String(error));
      }
    })();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };
  browser.on('targetcreated', attach);
  for (const target of browser.targets()) attach(target);
  await Promise.all(pending);
  return { requests, errors, ready: () => Promise.all(pending), unexpected: () => requests.filter(request =>
    request.origin !== origin || !['GET', 'HEAD'].includes(request.method) || request.queryLength || request.bodyPresent) };
}
