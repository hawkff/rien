// Google answers some API requests from flagged networks, VPN and proxy exits
// among them, with a page that says the network "may be sending automated
// queries" (HTTP 403 with HTML). The refusal is per request, so the same request
// often passes a moment later. The page does not try again: a refused queue
// request leaves the side panel loading and the song without a next one.
//
// Behind one VPN exit about 3 in 10 requests were refused, up to 4 in a row,
// and a refusal took 5 to 10 seconds to arrive. Eight tries leave about one
// request in 15,000 refused, after about a minute at worst.
const attempts = 8;
// A good answer takes about 0.3 s, a refusal 5 to 10 s: a read-only request
// without an answer after this gets a second copy, and the first good answer
// wins. A song no longer waits out a slow refusal to start.
const secondCopyAfter = 1500;
// Requests that only read, which a second copy or a new try can't repeat an
// action of
const readOnly = new Set([
  'player',
  'next',
  'browse',
  'search',
  'guide',
  'music/get_queue',
  'music/get_search_suggestions',
]);
const api = '/\u0079\u006f\u0075\u0074\u0075\u0062\u0065i/v1/';
/**
 * Marks the address of a read that the API server asks the page for. Such a
 * read answers its own caller, so it neither replaces nor is replaced by a
 * newer request of its kind. The mark never leaves the app.
 */
export const apiServerRead = 'rien-api-read';
const apiUrl = (url: string | URL) => {
  const target = URL.parse(url, location.href);
  return target?.pathname.startsWith(api) ? target : undefined;
};
const isBlocked = (response: Response) =>
  response.status === 403 &&
  !!response.headers.get('content-type')?.startsWith('text/html');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a request, and a second copy when it has no answer after `delay`.
 * Gives the first answer that isn't a refusal, or else a refusal, or the
 * error of the last copy to fail. The copy that loses stops.
 */
const sendTwice = (
  fetch: typeof window.fetch,
  request: Request,
  delay: number,
) =>
  new Promise<Response>((resolve, reject) => {
    const running = new Set<AbortController>();
    let refusal: Response | undefined;
    let done = false;
    const end = (winner?: AbortController) => {
      done = true;
      clearTimeout(timer);
      for (const copy of running) if (copy !== winner) copy.abort();
    };
    const send = () => {
      const copy = new AbortController();
      running.add(copy);
      fetch(request.clone(), {
        signal: AbortSignal.any([request.signal, copy.signal]),
      }).then(
        (response) => {
          running.delete(copy);
          if (done) return;
          if (!isBlocked(response)) {
            end(copy);
            resolve(response);
          } else if (running.size === 0) {
            end();
            resolve(response);
          } else {
            refusal = response;
          }
        },
        (error: unknown) => {
          running.delete(copy);
          if (done || running.size > 0) return;
          end();
          if (refusal) resolve(refusal);
          else
            reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    send();
    const timer = setTimeout(() => {
      if (!done) send();
    }, delay);
  });

/**
 * Whether a player answer is YouTube's "Sign in to confirm you're not a bot",
 * in any language: it asks for a sign-in, and its "Learn more" opens this
 * article. An age check asks for a sign-in too, with another article.
 */
export const isBotCheck = (answer: unknown) => {
  const { playabilityStatus: status } =
    (answer as {
      playabilityStatus?: {
        status?: string;
        reason?: string;
        errorScreen?: unknown;
      };
    } | null) ?? {};
  return (
    status?.status === 'LOGIN_REQUIRED' &&
    (JSON.stringify(status.errorScreen ?? null).includes('/answer/3037019') ||
      /not a bot/i.test(status.reason ?? ''))
  );
};
const botCheck = async (response: Response) =>
  response.ok &&
  isBotCheck(
    await response
      .clone()
      .json()
      .catch((): null => null),
  );

// Asks Rien to move to its next proxy exit, if it has exits to move along
type NextExit = (reason: 'bot-check' | 'refused') => Promise<boolean>;
const askNextExit: NextExit = (reason) =>
  window.ipcRenderer
    .invoke('peard:next-exit', reason)
    .then(Boolean, () => false);

// Sends an API request up to eight times while Google refuses it. Only the
// latest request of a kind tries again: the page shows every answer it gets,
// and an answer that comes after a newer request's answer would replace it,
// such as an earlier tab's content in the tab now open.
const latest = new Map<string, object>();
//
// With proxy exits set, a song's player request moves to the next exit when
// YouTube answers with its bot check, or refuses it twice in a row: those come
// from a distrusted exit. Other requests stay on the exit, since a move in the
// middle of a song would cut its stream, which is tied to the exit's address.
//
// A read-only request also gets a second copy when it has no answer in time,
// and tries again after a network error, such as a change of network.
export const retryBlocked =
  (
    fetch: typeof window.fetch,
    wait = pause,
    nextExit: NextExit = askNextExit,
    copyAfter = secondCopyAfter,
  ): typeof window.fetch =>
  async (input, init) => {
    const target = apiUrl(input instanceof Request ? input.url : input);
    if (!target) return fetch(input, init);
    const player = target.pathname === `${api}player`;
    // The mark comes with an address, as the page's XMLHttpRequest sends it;
    // a whole Request goes on as it is
    const own =
      !(input instanceof Request) && target.searchParams.has(apiServerRead);
    if (own) target.searchParams.delete(apiServerRead);
    const request = new Request(own ? target.href : input, init);
    const reads = readOnly.has(target.pathname.slice(api.length));
    const turn = {};
    if (!own) latest.set(target.pathname, turn);
    const current = () => own || latest.get(target.pathname) === turn;
    // The page's abort ends a wait at once
    const aborted = new Promise<never>((_, reject) =>
      request.signal.addEventListener(
        'abort',
        () => reject(request.signal.reason as Error),
        { once: true },
      ),
    );
    aborted.catch(() => {});
    const pauseFor = (ms: number) => Promise.race([wait(ms), aborted]);
    const attempt = async () => {
      for (let failures = 1; ; failures++) {
        try {
          return reads
            ? await sendTwice(fetch, request, copyAfter)
            : await fetch(request.clone());
        } catch (error) {
          // Aborted by the page, or a newer request of the kind went out:
          // this one fails as it came
          const over = () => request.signal.aborted || !current();
          if (!reads || failures >= 3 || over()) throw error;
          await pauseFor(failures * 1000);
          if (over()) throw error;
        }
      }
    };
    const first = await attempt();
    let response = first;
    let tries = 1;
    // Refusals in a row on the exit in use, and moves to other exits
    let refusals = 0;
    let moves = 0;
    for (;;) {
      const refused = isBlocked(response);
      const checked =
        !refused && player && current() && (await botCheck(response));
      if (!refused && !checked) break;
      if (refused) refusals++;
      // Only the latest request of its kind moves Rien's exit; Rien bounds
      // the moves, and this bounds a request
      let moved = false;
      if ((checked || (player && refusals >= 2)) && moves < 10 && current()) {
        moved = await nextExit(checked ? 'bot-check' : 'refused');
        if (moved) {
          moves++;
          refusals = 0;
        }
      }
      // A bot check with no exit to move to reaches the page
      if (checked && !moved) break;
      if (refused) {
        if (tries >= attempts) break;
        await pauseFor(tries * 300);
      }
      if (!current()) return first;
      response = await attempt();
      tries++;
    }
    return current() ? response : first;
  };

// The page's network manager sends its API requests through XMLHttpRequest:
// the queue request, and the reads that the API server's routes ask the page
// for. The app sends the read-only ones with fetch instead, with the tries
// above, and hands the answer to the page's request: the body through a blob
// URL, the status and headers as they came. A request that changes something
// goes once, as the page sent it.
const answerReadRequests = (fetch: typeof window.fetch) => {
  const proto = XMLHttpRequest.prototype;
  // The originals run with call(), on the request.
  /* oxlint-disable typescript/unbound-method */
  const {
    open,
    send,
    abort,
    setRequestHeader,
    getResponseHeader,
    getAllResponseHeaders,
  } = proto;
  const getter = <T>(name: 'status' | 'statusText' | 'responseURL') =>
    Object.getOwnPropertyDescriptor(proto, name)!.get! as (
      this: XMLHttpRequest,
    ) => T;
  /* oxlint-enable typescript/unbound-method */
  const native = {
    status: getter<number>('status'),
    statusText: getter<string>('statusText'),
    responseURL: getter<string>('responseURL'),
  };
  const requests = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; headers: [string, string][] }
  >();
  const running = new WeakMap<XMLHttpRequest, AbortController>();
  const answers = new WeakMap<XMLHttpRequest, Response>();
  // An answer counts from its headers on, as with the page's own requests.
  const answer = (xhr: XMLHttpRequest) =>
    xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED
      ? answers.get(xhr)
      : undefined;
  let empty: string | undefined;

  Object.defineProperties(proto, {
    status: {
      configurable: true,
      get(this: XMLHttpRequest) {
        return answer(this)?.status ?? native.status.call(this);
      },
    },
    statusText: {
      configurable: true,
      get(this: XMLHttpRequest) {
        return answer(this)?.statusText ?? native.statusText.call(this);
      },
    },
    responseURL: {
      configurable: true,
      get(this: XMLHttpRequest) {
        return answer(this)?.url ?? native.responseURL.call(this);
      },
    },
  });
  proto.getResponseHeader = function (name) {
    const found = answer(this);
    return found ? found.headers.get(name) : getResponseHeader.call(this, name);
  };
  proto.getAllResponseHeaders = function () {
    const found = answer(this);
    return found
      ? [...found.headers]
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join('')
      : getAllResponseHeaders.call(this);
  };

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    running.get(this)?.abort();
    running.delete(this);
    answers.delete(this);
    const target = async ? apiUrl(url) : undefined;
    if (target && readOnly.has(target.pathname.slice(api.length))) {
      requests.set(this, { method, url: target.href, headers: [] });
    } else {
      requests.delete(this);
    }
    open.call(this, method, url, async, username, password);
  };
  proto.setRequestHeader = function (name, value) {
    requests.get(this)?.headers.push([name, value]);
    setRequestHeader.call(this, name, value);
  };
  proto.send = function (body) {
    const request = requests.get(this);
    requests.delete(this);
    if (!request) return send.call(this, body);
    const controller = new AbortController();
    running.set(this, controller);
    const signals = [controller.signal];
    // The page's timeout, which starts with the page's own request otherwise
    if (this.timeout) signals.push(AbortSignal.timeout(this.timeout));
    (async () => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: body as BodyInit | null,
        signal: AbortSignal.any(signals),
      }).catch(() => undefined);
      const content = await response?.blob().catch(() => undefined);
      if (running.get(this) !== controller) return;
      running.delete(this);
      const url = URL.createObjectURL(content ?? new Blob());
      if (response && content) {
        answers.set(this, response);
        this.addEventListener('loadend', () => URL.revokeObjectURL(url), {
          once: true,
        });
      } else {
        // Without an answer, after three lost connections in a row, the
        // page's request fails as a network error: its blob is gone.
        URL.revokeObjectURL(url);
      }
      open.call(this, 'GET', url, true);
      send.call(this);
    })();
  };
  proto.abort = function () {
    const controller = running.get(this);
    running.delete(this);
    if (controller) {
      controller.abort();
      // The page's request was never sent. An empty answer stopped at once
      // gives the page the abort events it waits for.
      empty ??= URL.createObjectURL(new Blob());
      open.call(this, 'GET', empty, true);
      send.call(this);
    }
    abort.call(this);
  };
};

export const retryBlockedRequests = () => {
  window.fetch = retryBlocked(window.fetch.bind(window));
  answerReadRequests(window.fetch);
};
