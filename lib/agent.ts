// Client for the ADK agent (adk api_server). The agent queries the ClawMarket
// catalog through the MongoDB MCP server and returns a compact JSON pick:
//   { skill_id, reason, alternative_ids }
// We then hydrate full, authoritative skill details from MongoDB (falling back
// to the live catalog) so prices and purchase URLs are never model-invented.

import { fetchLiveCatalog, type Skill } from "./catalog";
import { mongoConfigured, skillsCollection } from "./mongodb";
import { toRecommendation, type MatchResult } from "./match";

const AGENT_API_URL = process.env.AGENT_API_URL || "http://127.0.0.1:8000";
const APP_NAME = process.env.AGENT_APP_NAME || "clawmatcher";

interface AgentPick {
  skill_id: string | null;
  reason: string;
  alternative_ids: string[];
}

/** Pull the JSON object out of the model's final text (tolerates ```json fences). */
function parseAgentPick(text: string): AgentPick | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      skill_id: typeof obj.skill_id === "string" ? obj.skill_id : null,
      reason: typeof obj.reason === "string" ? obj.reason : "",
      alternative_ids: Array.isArray(obj.alternative_ids)
        ? obj.alternative_ids.filter((x: unknown): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Fetch skills by id, preserving the requested order. Mongo first, live fallback. */
async function hydrateSkills(ids: string[]): Promise<Map<string, Skill>> {
  const wanted = new Set(ids);
  const byId = new Map<string, Skill>();

  if (mongoConfigured()) {
    try {
      const coll = await skillsCollection();
      const docs = await coll
        .find({ skill_id: { $in: [...wanted] } }, { projection: { _id: 0, embedding: 0 } })
        .toArray();
      for (const s of docs) byId.set(s.skill_id, s as Skill);
    } catch (err) {
      console.error("Agent hydrate: Mongo read failed, will try live catalog:", err);
    }
  }

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const catalog = await fetchLiveCatalog();
    for (const s of catalog) if (wanted.has(s.skill_id)) byId.set(s.skill_id, s);
  }
  return byId;
}

interface AdkPart {
  text?: string;
  functionCall?: unknown;
}
interface AdkEvent {
  content?: { role?: string; parts?: AdkPart[] };
}

/** Run the query through the ADK agent and return the final JSON text it emitted. */
async function runAgent(query: string): Promise<string> {
  const sessionId = `web-${crypto.randomUUID()}`;
  const base = `${AGENT_API_URL}/apps/${APP_NAME}/users/web/sessions/${sessionId}`;

  const created = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!created.ok) {
    throw new Error(`adk session create -> ${created.status}`);
  }

  const res = await fetch(`${AGENT_API_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_name: APP_NAME,
      user_id: "web",
      session_id: sessionId,
      new_message: { role: "user", parts: [{ text: query }] },
    }),
  });
  if (!res.ok) {
    throw new Error(`adk run -> ${res.status}: ${await res.text()}`);
  }

  const events = (await res.json()) as AdkEvent[];
  // The final answer is the last event carrying a text part.
  let finalText = "";
  for (const ev of events) {
    for (const part of ev.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text.trim()) finalText = part.text;
    }
  }
  return finalText;
}

/**
 * Match a query using the ADK + MongoDB MCP agent. Throws if the agent server is
 * unreachable or returns nothing usable (caller decides whether to fall back).
 */
export async function matchWithAgent(query: string): Promise<MatchResult> {
  const trimmed = query.trim();
  const text = await runAgent(trimmed);
  const pick = parseAgentPick(text);

  if (!pick) {
    throw new Error("Agent returned no parseable recommendation");
  }

  if (!pick.skill_id) {
    return {
      query: trimmed,
      recommendation: null,
      alternatives: [],
      source: mongoConfigured() ? "mongodb" : "live-api",
      ranked_by: "agent",
    };
  }

  const ids = [pick.skill_id, ...pick.alternative_ids.filter((id) => id !== pick.skill_id)];
  const byId = await hydrateSkills(ids);

  const top = byId.get(pick.skill_id);
  if (!top) {
    throw new Error(`Agent picked unknown skill_id ${pick.skill_id}`);
  }

  const alternatives = pick.alternative_ids
    .filter((id) => id !== pick.skill_id)
    .map((id) => byId.get(id))
    .filter((s): s is Skill => Boolean(s))
    .slice(0, 3)
    .map((s) => toRecommendation(s, s.best_for || s.description));

  return {
    query: trimmed,
    recommendation: toRecommendation(top, pick.reason || top.best_for || top.description),
    alternatives,
    source: mongoConfigured() ? "mongodb" : "live-api",
    ranked_by: "agent",
  };
}
