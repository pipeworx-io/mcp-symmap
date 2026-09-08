interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * SymMap v2 — Traditional Chinese Medicine association graph from symmap.org
 * (Beijing University of Chinese Medicine): herb <-> ingredient <-> protein
 * target <-> TCM symptom <-> modern (MM) symptom <-> disease, with every
 * relationship payload carrying an explicit evidence tier.
 *
 * SymMap records ASSOCIATIONS, not efficacy. Most edges are curated database
 * aggregations or computational predictions; none of them demonstrate that a
 * herb or ingredient treats anything. Every edge this pack returns carries
 * `evidence_tier` (traditional_use | human_clinical | laboratory |
 * computational_prediction) and `evidence_basis` saying where the edge comes
 * from, and every tool description repeats the caveat.
 *
 * TCM symptoms (SMTS), TCM syndromes (SMSY) and modern-medicine symptoms
 * (SMMS) are DISTINCT vocabularies in SymMap and stay distinct here — the
 * curated mapping between the TCM and modern vocabularies is itself data and
 * is returned as its own hop, never collapsed into one "symptom" field.
 *
 * Upstream shape: symmap.org serves plain HTTP only (no TLS) and answers
 * form-POST JSON endpoints (/search/, /related_components/). The herb entity
 * table ships baked into the pack (src/herbs.ts, generated from SymMap v2.0's
 * published SMHB download file) so herb lookup and name resolution never
 * depend on the upstream; relationship queries call the live endpoints
 * per-edge with a per-isolate memo, so the ~6 MB corpus is never re-fetched.
 * Some server-side joins (herb->gene, MM-symptom->herb) 502 upstream by
 * design of their backend; the tools here compose only the edge classes that
 * answer.
 */

import { HERB_ROWS, type HerbRow } from './herbs';

const UA = 'pipeworx-mcp-symmap/1.0 (+https://pipeworx.io)';
const BASE = 'http://www.symmap.org';

const EVIDENCE_NOTE =
  'SymMap records associations, NOT efficacy: an edge between a herb/ingredient and a target, symptom or disease is not evidence that anything treats anything. Read evidence_tier on every edge — computational_prediction edges are inferred, not demonstrated, and nothing in SymMap is a clinical trial result for a herb.';

const TIER = {
  traditional: 'traditional_use',
  clinical: 'human_clinical',
  laboratory: 'laboratory',
  predicted: 'computational_prediction',
} as const;

// symmap.org's own table_name vocabulary for /search/ and /related_components/.
const TABLE = {
  herb: 'Herb',
  ingredient: 'Mol',
  target: 'Gene',
  tcm_symptom: 'TCM_symptom',
  mm_symptom: 'MM_symptom',
  syndrome: 'Syndrome',
  disease: 'Disease',
} as const;
type EntityKind = keyof typeof TABLE;

// The corpus is static (SymMap v2.0, published 2022), so a per-isolate memo is
// safe and spares the upstream — an academic Django server that 502s under
// load — repeated identical joins.
const memo = new Map<string, Promise<unknown>>();

async function postForm(path: string, form: Record<string, string>): Promise<unknown> {
  const key = path + '?' + new URLSearchParams(form).toString();
  const hit = memo.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetchWithTimeout(
      `${BASE}${path}`,
      {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      },
      'symmap.org',
      20000,
    );
    if (res.status === 502) {
      throw new Error(
        'symmap.org answered 502 for this join. Its backend serves some edge directions and not others (herb->target and modern-symptom->herb 502 by design of their server); if this was a supported direction, the server is briefly overloaded — retry once in a few seconds, do not loop.',
      );
    }
    if (!res.ok) throw await httpError(res, 'symmap.org');
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`symmap.org returned non-JSON — ${summarizeErrorBody(text)}`);
    }
  })();
  p.catch(() => memo.delete(key));
  if (memo.size > 500) memo.clear();
  memo.set(key, p);
  return p;
}

async function relatedRows(rrid: string, table: string): Promise<Record<string, unknown>[]> {
  const data = (await postForm('/related_components/', {
    rrid,
    table_name: table,
    filter: 'All',
  })) as { data?: Record<string, unknown>[] };
  return data.data ?? [];
}

async function searchRows(kind: EntityKind, key: string): Promise<Record<string, unknown>[]> {
  const data = (await postForm('/search/', { table_name: TABLE[kind], key })) as {
    data?: Record<string, unknown>[];
  };
  return data.data ?? [];
}

// ---------------------------------------------------------------------------
// Baked herb index (698 herbs from the SymMap v2.0 SMHB table)

interface Herb {
  herb_id: string;
  chinese_name: string;
  pinyin_name: string;
  latin_name: string;
  english_name: string;
  properties: string;
  properties_chinese: string;
  meridians: string;
  meridians_chinese: string;
  class: string;
  class_chinese: string;
  use_part: string;
  alias: string;
}

function toHerb(r: HerbRow): Herb {
  return {
    herb_id: `SMHB${String(r[0]).padStart(5, '0')}`,
    chinese_name: r[1],
    pinyin_name: r[2],
    latin_name: r[3],
    english_name: r[4],
    properties: r[5],
    properties_chinese: r[6],
    meridians: r[7],
    meridians_chinese: r[8],
    class: r[9],
    class_chinese: r[10],
    use_part: r[11],
    alias: r[12],
  };
}

// Casefold and strip separators so pinyin spacing/case never matter and CJK
// passes through: "Ren Shen" -> "renshen", "人参" -> "人参".
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

interface HerbKeyed {
  herb: Herb;
  keys: string[];
}

let HERB_INDEX: HerbKeyed[] | null = null;

function herbIndex(): HerbKeyed[] {
  if (!HERB_INDEX) {
    HERB_INDEX = HERB_ROWS.map((r) => {
      const herb = toHerb(r);
      const keys = [
        herb.herb_id,
        String(r[0]),
        herb.chinese_name,
        herb.pinyin_name,
        herb.english_name,
        ...herb.latin_name.split(','),
        ...herb.alias.split(','),
      ]
        .map(norm)
        .filter(Boolean);
      return { herb, keys };
    });
  }
  return HERB_INDEX;
}

function resolveHerb(query: string): { match: Herb | null; alternatives: Herb[] } {
  const q = norm(query);
  if (!q) return { match: null, alternatives: [] };
  const exact = herbIndex().filter((h) => h.keys.some((k) => k === q));
  if (exact.length > 0) return { match: exact[0].herb, alternatives: exact.slice(1).map((h) => h.herb) };
  const partial = herbIndex().filter((h) => h.keys.some((k) => k.includes(q)));
  return {
    match: partial.length > 0 ? partial[0].herb : null,
    alternatives: partial.slice(1, 6).map((h) => h.herb),
  };
}

// ---------------------------------------------------------------------------
// Evidence handling

// /related_components/ returns literature evidence as an HTML snippet with
// embedded PubMed links; strip it to text + PMIDs.
function parseEvidence(html: unknown): { pmids: string[]; excerpt: string } {
  if (typeof html !== 'string' || html.trim() === '') return { pmids: [], excerpt: '' };
  const pmids = [...html.matchAll(/PMID:\s*(\d+)/g)].map((m) => m[1]);
  // The snippet carries the same sentence twice (a truncated "shortResult" and
  // the full "longResult") plus a Fold button; keep only the long variant.
  const long = html.match(/class="longResult[^"]*">([\s\S]*?)<\/div>/);
  const text = (long ? long[1] : html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { pmids: [...new Set(pmids)], excerpt: text.slice(0, 300) };
}

const BASIS = {
  herbIngredient:
    'phytochemical constituent record — this molecule has been identified in the herb (aggregated by SymMap from TCMID / TCM-ID / TCMSP); says nothing about clinical effect',
  herbTcmSymptom:
    'traditional indication curated by SymMap from the Chinese Pharmacopoeia (2015); traditional use, not validated by clinical trials',
  herbSyndrome:
    'traditional TCM syndrome association curated by SymMap from TCM literature; traditional use, not validated by clinical trials',
  crosswalk:
    'expert terminology mapping between a TCM symptom term and a modern medical symptom term (UMLS/MeSH), curated by SymMap from how TCM literature defines the symptom; a vocabulary crosswalk, not evidence of treatment',
  targetCited:
    'molecular experiment reported in the cited publication(s) (evidence_pmids); a laboratory finding about the molecule and the protein, not clinical efficacy',
  targetUncited:
    'ingredient–target association carried by SymMap without a cited experiment; treat as predicted',
  diseaseGenetic:
    'human genetic gene–disease association (OMIM/Orphanet identifiers present); links the GENE to the disease — it is NOT evidence that any herb or ingredient treats the disease',
  diseasePredicted:
    'gene–disease association carried by SymMap without human-genetics identifiers; treat as predicted',
} as const;

// ---------------------------------------------------------------------------
// Tools

const tools: McpToolExport['tools'] = [
  {
    name: 'symmap_search',
    description:
      'Resolve a name to SymMap v2 (symmap.org, Beijing University of Chinese Medicine) entity records and ids across the Traditional Chinese Medicine association graph: herbs, ingredients (molecules), protein targets (genes), TCM symptoms, modern medical symptoms, TCM syndromes, diseases. Accepts Chinese characters, pinyin, Latin or English names, gene symbols, disease names. Returns the SMHB/SMIT/SMTT/SMTS/SMMS/SMSY/SMDE ids the relationship tools take. SymMap records associations, not efficacy.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Name to look up — e.g. "ginseng", "人参", "Renshen", "quercetin", "IL6", "malaria", "insomnia"',
        },
        entity: {
          type: 'string',
          enum: ['herb', 'ingredient', 'target', 'tcm_symptom', 'mm_symptom', 'syndrome', 'disease'],
          description:
            'Which entity class to search. tcm_symptom is the traditional vocabulary (SMTS), mm_symptom the modern medical one (SMMS) — they are distinct in SymMap and here.',
        },
        limit: { type: 'number', description: 'Max matches returned, 1-50 (default 10)' },
      },
      required: ['query', 'entity'],
    },
  },
  {
    name: 'symmap_herb',
    description:
      'Full record for one of the 698 herbs in SymMap v2 (symmap.org): Chinese/pinyin/Latin/English names, TCM properties (nature/flavour), meridians, drug class, used part — bilingual, answered from the SymMap v2.0 published herb table. Accepts any name form or a SMHB id. Traditional TCM attributes describe traditional use, not clinically demonstrated effect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        herb: {
          type: 'string',
          description: 'Herb name in any script (人参 / Renshen / Ginseng / Ginseng Radix Et Rhizoma) or SMHB id (SMHB00336)',
        },
      },
      required: ['herb'],
    },
  },
  {
    name: 'symmap_herb_ingredients',
    description:
      'Chemical ingredients (molecules) identified in a Traditional Chinese Medicine herb, from SymMap v2 (symmap.org) — with PubChem CID, CAS number and oral-bioavailability score per molecule. Every edge carries evidence_tier and evidence_basis. Constituent presence is a laboratory identification; it is NOT evidence the herb or the molecule treats anything.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        herb: { type: 'string', description: 'Herb name in any script or SMHB id' },
        limit: { type: 'number', description: 'Max ingredients returned, 1-200 (default 50)' },
      },
      required: ['herb'],
    },
  },
  {
    name: 'symmap_herb_symptoms',
    description:
      'Traditional indications of a Traditional Chinese Medicine herb from SymMap v2 (symmap.org): the TCM symptoms (SMTS) and TCM syndromes (SMSY) it is traditionally used for, per the Chinese Pharmacopoeia as curated by SymMap. These are TRADITIONAL-USE records (evidence_tier on every edge), not clinical evidence, and TCM symptoms are kept separate from modern medical symptoms — use symmap_symptom_herbs with system:"modern" to enter from the modern vocabulary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        herb: { type: 'string', description: 'Herb name in any script or SMHB id' },
        limit: { type: 'number', description: 'Max symptoms and syndromes returned each, 1-200 (default 50)' },
      },
      required: ['herb'],
    },
  },
  {
    name: 'symmap_symptom_herbs',
    description:
      'Herbs traditionally associated with a symptom in SymMap v2 (symmap.org). system:"tcm" looks up a Traditional Chinese Medicine symptom (SMTS) directly; system:"modern" starts from a modern medical symptom (SMMS), returns its curated TCM-symptom crosswalk, then the herbs per mapped TCM symptom — the two vocabularies and the mapping hop stay explicit, never merged. Every hop carries evidence_tier; a traditional-use association is not evidence of effectiveness.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symptom: {
          type: 'string',
          description: 'Symptom name — TCM (e.g. 痹痛 / "Bi Tong") for system:"tcm", modern medical (e.g. "insomnia", "Arthritic Pains") for system:"modern"',
        },
        system: {
          type: 'string',
          enum: ['tcm', 'modern'],
          description: 'Which symptom vocabulary the name belongs to. They are distinct in SymMap; this tool never merges them.',
        },
        limit: { type: 'number', description: 'Max herbs returned per symptom, 1-100 (default 25)' },
      },
      required: ['symptom', 'system'],
    },
  },
  {
    name: 'symmap_ingredient',
    description:
      'One Traditional Chinese Medicine ingredient (molecule) from SymMap v2 (symmap.org): its protein targets with literature evidence (PubMed-cited edges are tier "laboratory", uncited ones "computational_prediction") and the herbs it has been identified in. A target association is a molecular finding or a prediction — NOT evidence the ingredient treats any condition.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ingredient: {
          type: 'string',
          description: 'Ingredient name (e.g. "quercetin") or SMIT id (SMIT00013)',
        },
        targets_limit: { type: 'number', description: 'Max protein targets returned, 1-200 (default 50)' },
        herbs_limit: { type: 'number', description: 'Max source herbs returned, 1-200 (default 25)' },
      },
      required: ['ingredient'],
    },
  },
  {
    name: 'symmap_target_diseases',
    description:
      'Diseases associated with a protein target (gene) in SymMap v2 (symmap.org), with OMIM/Orphanet identifiers where the association comes from human genetics. Every edge carries evidence_tier: human_clinical for OMIM/Orphanet-backed gene–disease links, computational_prediction otherwise. A gene–disease link says NOTHING about any herb or ingredient treating the disease.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Gene symbol (e.g. "IL6", "A2M") or SMTT id (SMTT00001)',
        },
        limit: { type: 'number', description: 'Max diseases returned, 1-200 (default 50)' },
      },
      required: ['target'],
    },
  },
];

// ---------------------------------------------------------------------------

function clampLimit(v: unknown, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const ATTRIBUTION =
  'Data: SymMap v2 (symmap.org), Beijing University of Chinese Medicine — Wu et al., Nucleic Acids Research 2019, doi:10.1093/nar/gky1021. Academic database; cite the paper when publishing results.';

function detailUrl(id: string): string {
  return `${BASE}/detail/${id}`;
}

async function resolveHerbOrThrow(raw: string): Promise<{ herb: Herb; alternatives: Herb[] }> {
  const { match, alternatives } = resolveHerb(raw);
  if (!match) {
    throw new Error(
      `No SymMap herb matches "${raw}". Try the Chinese name, pinyin (with or without spaces), Latin pharmacopoeia name, English name, or a SMHB id; symmap_search with entity:"herb" also resolves names.`,
    );
  }
  return { herb: match, alternatives };
}

async function doSearch(args: Record<string, unknown>) {
  const query = str(args.query);
  const entity = str(args.entity) as EntityKind;
  if (!query) throw new Error('query is required');
  if (!(entity in TABLE)) {
    throw new Error(`entity must be one of: ${Object.keys(TABLE).join(', ')}`);
  }
  const limit = clampLimit(args.limit, 50, 10);
  // Herbs resolve against the baked table first — richer record, no upstream
  // dependency; the live /search/ covers the rest.
  if (entity === 'herb') {
    const { match, alternatives } = resolveHerb(query);
    const matches = match ? [match, ...alternatives] : [];
    if (matches.length > 0) {
      return {
        source: 'SymMap v2 herb table (symmap.org)',
        attribution: ATTRIBUTION,
        note: EVIDENCE_NOTE,
        total_matches: matches.length,
        matches: matches.slice(0, limit).map((h) => ({ ...h, detail_url: detailUrl(h.herb_id) })),
      };
    }
    // fall through to the live search for spellings the baked keys miss
  }
  const rows = await searchRows(entity, query);
  return {
    source: 'SymMap v2 live search (symmap.org)',
    attribution: ATTRIBUTION,
    note: EVIDENCE_NOTE,
    total_matches: rows.length,
    matches: rows.slice(0, limit),
  };
}

async function doHerb(args: Record<string, unknown>) {
  const { herb, alternatives } = await resolveHerbOrThrow(str(args.herb));
  return {
    source: 'SymMap v2 herb table (symmap.org)',
    attribution: ATTRIBUTION,
    note: 'TCM properties, meridians and class describe traditional use, not clinically demonstrated effect.',
    herb: { ...herb, detail_url: detailUrl(herb.herb_id) },
    other_matches: alternatives.map((h) => ({ herb_id: h.herb_id, pinyin_name: h.pinyin_name, english_name: h.english_name })),
  };
}

async function doHerbIngredients(args: Record<string, unknown>) {
  const { herb } = await resolveHerbOrThrow(str(args.herb));
  const limit = clampLimit(args.limit, 200, 50);
  const rows = await relatedRows(herb.herb_id, TABLE.ingredient);
  return {
    source: 'SymMap v2 herb–ingredient associations (symmap.org)',
    attribution: ATTRIBUTION,
    note: EVIDENCE_NOTE,
    herb: { herb_id: herb.herb_id, pinyin_name: herb.pinyin_name, english_name: herb.english_name },
    total_ingredients: rows.length,
    ingredients: rows.slice(0, limit).map((r) => {
      const ev = parseEvidence(r.evidence);
      return {
        ingredient_id: r.MOL_id,
        name: r.Molecule_name,
        pubchem_cid: r.PubChem_CID || null,
        cas_id: r.CAS_id || null,
        oral_bioavailability_score: r.OB_score ?? null,
        evidence_tier: TIER.laboratory,
        evidence_basis: BASIS.herbIngredient,
        ...(ev.pmids.length > 0 ? { evidence_pmids: ev.pmids } : {}),
      };
    }),
  };
}

async function doHerbSymptoms(args: Record<string, unknown>) {
  const { herb } = await resolveHerbOrThrow(str(args.herb));
  const limit = clampLimit(args.limit, 200, 50);
  const [tcm, syndromes] = await Promise.all([
    relatedRows(herb.herb_id, TABLE.tcm_symptom),
    relatedRows(herb.herb_id, TABLE.syndrome),
  ]);
  return {
    source: 'SymMap v2 herb–symptom and herb–syndrome associations (symmap.org)',
    attribution: ATTRIBUTION,
    note: `${EVIDENCE_NOTE} TCM symptoms (SMTS) and TCM syndromes (SMSY) below are the traditional vocabularies; modern medical symptoms are a separate vocabulary — enter it via symmap_symptom_herbs {system:"modern"}.`,
    herb: { herb_id: herb.herb_id, pinyin_name: herb.pinyin_name, english_name: herb.english_name },
    total_tcm_symptoms: tcm.length,
    tcm_symptoms: tcm.slice(0, limit).map((r) => ({
      tcm_symptom_id: r.TCM_symptom_id,
      name_chinese: r.TCM_symptom_name,
      pinyin: r.Symptom_pinyin,
      locus: r.Symptom_locus ?? null,
      property: r.Symptom_property ?? null,
      evidence_tier: TIER.traditional,
      evidence_basis: BASIS.herbTcmSymptom,
    })),
    total_syndromes: syndromes.length,
    syndromes: syndromes.slice(0, limit).map((r) => ({
      syndrome_id: r.Syndrome_id,
      name_chinese: r.Syndrome_name,
      name_english: str(r.Syndrome_English) || null,
      pinyin: r.Syndrome_Pinyin,
      evidence_tier: TIER.traditional,
      evidence_basis: BASIS.herbSyndrome,
    })),
  };
}

function herbEdge(r: Record<string, unknown>, basis: string) {
  return {
    herb_id: r.Herb_id,
    pinyin_name: r.Pinyin_name,
    chinese_name: r.Chinese_name,
    english_name: r.English_name,
    latin_name: r.Latin_name,
    class: r.Class_English,
    evidence_tier: TIER.traditional,
    evidence_basis: basis,
  };
}

async function doSymptomHerbs(args: Record<string, unknown>) {
  const symptom = str(args.symptom);
  const system = str(args.system);
  const limit = clampLimit(args.limit, 100, 25);
  if (!symptom) throw new Error('symptom is required');

  if (system === 'tcm') {
    const rows = await searchRows('tcm_symptom', symptom);
    if (rows.length === 0) {
      throw new Error(
        `No SymMap TCM symptom matches "${symptom}". TCM symptom names are Chinese terms (pinyin also matches, e.g. "Bi Tong"); for an English modern-medicine symptom use system:"modern".`,
      );
    }
    const id = String(rows[0].TCM_symptom_id);
    const herbs = await relatedRows(id, TABLE.herb);
    return {
      source: 'SymMap v2 TCM symptom–herb associations (symmap.org)',
      attribution: ATTRIBUTION,
      note: EVIDENCE_NOTE,
      system: 'tcm',
      matched_symptom: rows[0],
      total_herbs: herbs.length,
      herbs: herbs.slice(0, limit).map((r) => herbEdge(r, BASIS.herbTcmSymptom)),
    };
  }

  if (system === 'modern') {
    const rows = await searchRows('mm_symptom', symptom);
    if (rows.length === 0) {
      throw new Error(
        `No SymMap modern medical symptom matches "${symptom}". Try the MeSH-style term (e.g. "Arthritic Pains", "Insomnia"); for a TCM term use system:"tcm".`,
      );
    }
    const mm = rows[0];
    const mmId = String(mm.MM_symptom_id);
    const mapped = await relatedRows(mmId, TABLE.tcm_symptom);
    const top = mapped.slice(0, 3);
    const herbsBySymptom = [];
    for (const t of top) {
      const herbs = await relatedRows(String(t.TCM_symptom_id), TABLE.herb);
      herbsBySymptom.push({
        tcm_symptom: {
          tcm_symptom_id: t.TCM_symptom_id,
          name_chinese: t.TCM_symptom_name,
          pinyin: t.Symptom_pinyin,
          evidence_tier: TIER.traditional,
          evidence_basis: BASIS.crosswalk,
        },
        total_herbs: herbs.length,
        herbs: herbs.slice(0, limit).map((r) => herbEdge(r, BASIS.herbTcmSymptom)),
      });
    }
    return {
      source: 'SymMap v2 modern-symptom -> TCM-symptom crosswalk + TCM symptom–herb associations (symmap.org)',
      attribution: ATTRIBUTION,
      note: `${EVIDENCE_NOTE} The modern vocabulary reaches herbs only through the curated TCM-symptom crosswalk; both hops are explicit below and each carries its own tier.`,
      system: 'modern',
      matched_mm_symptom: mm,
      total_mapped_tcm_symptoms: mapped.length,
      herbs_by_tcm_symptom: herbsBySymptom,
    };
  }

  throw new Error('system must be "tcm" or "modern" — SymMap keeps the two symptom vocabularies distinct, and so does this tool.');
}

async function resolveIngredientId(raw: string): Promise<{ id: string; record: Record<string, unknown> | null }> {
  const m = raw.toUpperCase().match(/^SMIT0*(\d+)$/);
  if (m) return { id: `SMIT${m[1].padStart(5, '0')}`, record: null };
  const rows = await searchRows('ingredient', raw);
  if (rows.length === 0) {
    throw new Error(`No SymMap ingredient matches "${raw}". Try the molecule name (e.g. "quercetin") or a SMIT id.`);
  }
  return { id: String(rows[0].MOL_id), record: rows[0] };
}

async function doIngredient(args: Record<string, unknown>) {
  const raw = str(args.ingredient);
  if (!raw) throw new Error('ingredient is required');
  const targetsLimit = clampLimit(args.targets_limit, 200, 50);
  const herbsLimit = clampLimit(args.herbs_limit, 200, 25);
  const { id, record } = await resolveIngredientId(raw);
  const [targets, herbs] = await Promise.all([
    relatedRows(id, TABLE.target),
    relatedRows(id, TABLE.herb),
  ]);
  return {
    source: 'SymMap v2 ingredient–target and ingredient–herb associations (symmap.org)',
    attribution: ATTRIBUTION,
    note: EVIDENCE_NOTE,
    ingredient_id: id,
    ingredient: record,
    detail_url: detailUrl(id),
    total_targets: targets.length,
    targets: targets.slice(0, targetsLimit).map((r) => {
      const ev = parseEvidence(r.evidence);
      const cited = ev.pmids.length > 0 || ev.excerpt.length > 0;
      return {
        target_id: r.Gene_id,
        gene_symbol: r.Gene_symbol ?? null,
        protein_name: r.Protein_name ?? null,
        uniprot_id: r.UniProt_id ?? null,
        ensembl_id: r.Ensembl_id ?? null,
        evidence_tier: cited ? TIER.laboratory : TIER.predicted,
        evidence_basis: cited ? BASIS.targetCited : BASIS.targetUncited,
        ...(ev.pmids.length > 0 ? { evidence_pmids: ev.pmids } : {}),
        ...(ev.excerpt ? { evidence_excerpt: ev.excerpt } : {}),
      };
    }),
    total_source_herbs: herbs.length,
    source_herbs: herbs.slice(0, herbsLimit).map((r) => herbEdge(r, BASIS.herbIngredient)).map((h) => ({
      ...h,
      evidence_tier: TIER.laboratory,
    })),
  };
}

async function doTargetDiseases(args: Record<string, unknown>) {
  const raw = str(args.target);
  if (!raw) throw new Error('target is required');
  const limit = clampLimit(args.limit, 200, 50);
  let id: string;
  let record: Record<string, unknown> | null = null;
  const m = raw.toUpperCase().match(/^SMTT0*(\d+)$/);
  if (m) {
    id = `SMTT${m[1].padStart(5, '0')}`;
  } else {
    const rows = await searchRows('target', raw);
    if (rows.length === 0) {
      throw new Error(`No SymMap protein target matches "${raw}". Try the HGNC gene symbol (e.g. "IL6") or a SMTT id.`);
    }
    // Prefer the exact gene-symbol match over substring hits (IL6 vs IL6R).
    const exact = rows.find((r) => str(r.Gene_symbol).toUpperCase() === raw.toUpperCase());
    record = exact ?? rows[0];
    id = String(record.Gene_id);
  }
  const rows = await relatedRows(id, TABLE.disease);
  return {
    source: 'SymMap v2 target–disease associations (symmap.org)',
    attribution: ATTRIBUTION,
    note: EVIDENCE_NOTE,
    target_id: id,
    target: record,
    detail_url: detailUrl(id),
    total_diseases: rows.length,
    diseases: rows.slice(0, limit).map((r) => {
      const genetic = Boolean(str(r.OMIM_id) || str(r.Orphanet_id));
      return {
        disease_id: r.Disease_id,
        name: r.Disease_name,
        omim_id: str(r.OMIM_id) || null,
        orphanet_id: str(r.Orphanet_id) || null,
        evidence_tier: genetic ? TIER.clinical : TIER.predicted,
        evidence_basis: genetic ? BASIS.diseaseGenetic : BASIS.diseasePredicted,
      };
    }),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'symmap_search':
      return doSearch(args);
    case 'symmap_herb':
      return doHerb(args);
    case 'symmap_herb_ingredients':
      return doHerbIngredients(args);
    case 'symmap_herb_symptoms':
      return doHerbSymptoms(args);
    case 'symmap_symptom_herbs':
      return doSymptomHerbs(args);
    case 'symmap_ingredient':
      return doIngredient(args);
    case 'symmap_target_diseases':
      return doTargetDiseases(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
