import "server-only";
import OpenAI from "openai";
import { getSetting, setSetting } from "../db";
import { seal, unseal } from "../vault";

// Models from every provider through AnyRouter, one OpenAI-compatible gateway. Off until the user
// adds an AnyRouter key (Settings, or ANYROUTER_API_KEY). Dots pick these models like any other;
// their ids carry an "anyrouter:" prefix, e.g. "anyrouter:z-ai/glm-5.3-flash".
// AnyRouter stores responses, so it keeps conversation state like OpenAI's does.
// It has no server-side web search and no computer tool, so dots on these models read pages instead.

export const ANYROUTER_PREFIX = "anyrouter:";
const BASE_URL = "https://anyrouter.dev/api/v1";
const KEY_SETTING = "anyrouter_key";
/** How many models the picker offers. The defaults below are picked from the whole catalog. */
export const ANYROUTER_PICKER_MAX = 40;
// AnyRouter's own router: a fixed id that resolves to whatever this key can reach.
const ROUTER = ANYROUTER_PREFIX + "anyrouter/auto";
// A response id that can't exist, used to check a key without spending anything.
const KEY_PROBE = "resp_open_dot_key_check";
// Attribution headers AnyRouter uses to credit the app in its dashboard and public rankings.
const HEADERS = {
  "HTTP-Referer": "https://github.com/duyet/open-dot",
  "X-AnyRouter-Title": "Open Dot",
  "X-AnyRouter-Source": "desktop",
};
// A router that only works across a workspace's own keys, which a plain API key has none of.
const SKIP = [/^anyrouter\/decision$/];
// Best first when a model has to be picked for the user (no OpenAI key yet, or no choice made).
// AnyRouter's own routers lead because they resolve to whatever this particular key can actually
// reach: a named vendor model is regularly BYOK-only or has no upstream at all, and a default that
// 502s takes the whole turn down with it. Everything below is one that answered a live request.
const MAIN_PREFERENCE = [/^anyrouter\/auto$/, /^moonshotai\/kimi-k\d/, /^nvidia\/nemotron-3-ultra/, /^anyrouter\/latest$/];
// The rule checker and chat titles are short calls, so they take the same reliable route first.
const SMALL_PREFERENCE = [/^anyrouter\/auto$/, /^anyrouter\/free$/, /^nvidia\/nemotron-3\.5-lightning/, /^anyrouter\/coding$/];

const g = globalThis as unknown as { __dotsAnyRouter?: { key: string; client: OpenAI }; __dotsAnyModels?: { at: number; ids: string[] } };

function envKey(): string | null {
  return process.env.ANYROUTER_API_KEY || null;
}

export function anyRouterKey(): string | null {
  if (envKey()) return envKey();
  const sealed = getSetting(KEY_SETTING);
  if (!sealed) return null;
  try {
    return unseal(sealed);
  } catch {
    return null;
  }
}

export const anyRouterSource = (): "env" | "settings" | null => (envKey() ? "env" : getSetting(KEY_SETTING) ? "settings" : null);

export const isAnyRouterModel = (model: string) => model.startsWith(ANYROUTER_PREFIX);
export const anyRouterId = (model: string) => model.slice(ANYROUTER_PREFIX.length);

export function anyrouter(): OpenAI {
  const key = anyRouterKey();
  if (!key) throw new Error("No AnyRouter key yet. Add one in Settings to use models from other providers.");
  if (g.__dotsAnyRouter?.key !== key) g.__dotsAnyRouter = { key, client: new OpenAI({ apiKey: key, baseURL: BASE_URL, defaultHeaders: HEADERS }) };
  return g.__dotsAnyRouter.client;
}

/** Check the key with AnyRouter, then save it encrypted. An empty key removes it. Returns an error or null. */
export async function saveAnyRouterKey(key: string): Promise<string | null> {
  if (envKey()) return "The AnyRouter key is set by ANYROUTER_API_KEY.";
  if (!key) {
    setSetting(KEY_SETTING, null);
    return null;
  }
  try {
    // AnyRouter gives inference keys no key-info route (GET /auth/key errors out), so ask for a response
    // that doesn't exist instead: 404 means the key was accepted, 401 means it wasn't. Nothing is billed.
    const res = await fetch(`${BASE_URL}/responses/${KEY_PROBE}`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) return "AnyRouter didn't accept that key.";
    if (!res.ok && res.status !== 404) return `Couldn't check the key with AnyRouter (${res.status}).`;
  } catch (err) {
    return `Couldn't reach AnyRouter: ${err instanceof Error ? err.message : String(err)}`;
  }
  setSetting(KEY_SETTING, seal(key));
  g.__dotsAnyModels = undefined;
  return null;
}

// The catalog files vision models under "multimodal", so filter on the ability to call tools and nothing else.
/** Every model this key can call as tools, newest first, as app model ids. Cached for an hour. */
export async function anyRouterModels(): Promise<string[]> {
  if (!anyRouterKey()) return [];
  if (g.__dotsAnyModels && Date.now() - g.__dotsAnyModels.at < 3_600_000) return g.__dotsAnyModels.ids;
  const res = await fetch(`${BASE_URL}/models?capability=function-calling`, { headers: { Authorization: `Bearer ${anyRouterKey()}` } });
  if (!res.ok) throw new Error(`AnyRouter models: ${res.status}`);
  const { data } = (await res.json()) as { data: { id: string; created?: number }[] };
  const ids = data.filter((m) => !SKIP.some((re) => re.test(m.id))).sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map((m) => ANYROUTER_PREFIX + m.id);
  g.__dotsAnyModels = { at: Date.now(), ids };
  return ids;
}

// Preference first, then the oldest entry as the fallback: ids arrive newest-first, so ids[0] would
// hand the rule checker the newest — and dearest — model whenever the catalog holds nothing we know.
// With no list at all, fall back to AnyRouter's own router: a fixed id rather than a catalog entry,
// so it still reaches something the key can use even when /models didn't answer.
const pick = (ids: string[], prefs: RegExp[]) => prefs.map((re) => ids.find((id) => re.test(anyRouterId(id)))).find(Boolean) ?? ids[ids.length - 1] ?? ROUTER;

/** The default agent model, and the default for rule review and chat titles. Both read the whole
 * list rather than the slice the picker shows, so a preferred model can't hide behind that cap. */
export const preferredAnyModel = (ids: string[]) => pick(ids, MAIN_PREFERENCE);
export const smallAnyModel = (ids: string[]) => pick(ids, SMALL_PREFERENCE);
