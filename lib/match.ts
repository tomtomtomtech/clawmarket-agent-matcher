import { fetchLiveCatalog, type Skill } from "./catalog";
import { mongoConfigured, skillsCollection } from "./mongodb";
import { embedText } from "./embeddings";

const VECTOR_INDEX = process.env.MONGODB_VECTOR_INDEX || "vector_index";

export interface Recommendation {
  agent_name: string;
  skill_name: string;
  description: string;
  best_for: string;
  category: string;
  price: number | null;
  currency: string;
  marks_price: number | null;
  purchase_url: string;
  reason: string;
}

export interface MatchResult {
  query: string;
  recommendation: Recommendation | null;
  alternatives: Recommendation[];
  source: "mongodb" | "live-api";
  ranked_by: "vector+gemini" | "vector" | "gemini" | "keyword";
}

const STOPWORDS = new Set([
  "i", "a", "an", "the", "to", "for", "my", "me", "of", "and", "or", "is", "are",
  "need", "want", "help", "with", "can", "you", "please", "someone", "some", "get",
  "looking", "would", "like", "on", "in", "it", "that", "this", "do", "how", "best",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

/** Cheap, deterministic relevance score. Weights title + tags above body text. */
function scoreSkill(queryTokens: string[], skill: Skill): number {
  if (queryTokens.length === 0) return 0;
  const title = skill.skill_name.toLowerCase();
  const tags = skill.tags.join(" ").toLowerCase();
  const bestFor = skill.best_for.toLowerCase();
  const body = skill.search_text;

  let score = 0;
  for (const tok of new Set(queryTokens)) {
    if (title.includes(tok)) score += 5;
    if (tags.includes(tok)) score += 4;
    // best_for is a curated "best for <use case>" intent line — strong signal.
    if (bestFor.includes(tok)) score += 4;
    else if (body.includes(tok)) score += 1;
  }
  // Small nudge toward higher-rated skills as a tie-breaker.
  score += Math.min(skill.rating_avg ?? 0, 5) * 0.1;
  return score;
}

async function getCandidates(): Promise<{ skills: Skill[]; source: "mongodb" | "live-api" }> {
  if (mongoConfigured()) {
    try {
      const coll = await skillsCollection();
      const skills = await coll.find({}, { projection: { _id: 0 } }).toArray();
      console.log(`[match] mongo catalog fetch returned ${skills.length} skills`);
      if (skills.length > 0) return { skills, source: "mongodb" };
    } catch (err) {
      console.error("Mongo read failed, falling back to live API:", err);
    }
  }
  // Fallback keeps the demo real: pull the live catalog directly.
  const liveSkills = await fetchLiveCatalog();
  console.log(`[match] live-api catalog fetch returned ${liveSkills.length} skills`);
  return { skills: liveSkills, source: "live-api" };
}

/**
 * Semantic retrieval via MongoDB Atlas Vector Search.
 * Returns the top candidates, or null if Mongo/embeddings/the index aren't available
 * (caller then falls back to keyword retrieval).
 */
async function vectorCandidates(query: string): Promise<Skill[] | null> {
  if (!mongoConfigured()) return null;
  const queryVector = await embedText(query, "RETRIEVAL_QUERY");
  if (!queryVector) return null;

  try {
    const coll = await skillsCollection();
    const results = await coll
      .aggregate<Skill>([
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: "embedding",
            queryVector,
            numCandidates: 100,
            limit: 8,
          },
        },
        { $project: { _id: 0, embedding: 0 } },
      ])
      .toArray();
    return results.length > 0 ? results : null;
  } catch (err) {
    // Index missing / not an Atlas cluster / not yet seeded with embeddings.
    console.error("Vector search unavailable, falling back to keyword:", err);
    return null;
  }
}

function toRecommendation(skill: Skill, reason: string): Recommendation {
  return {
    agent_name: skill.agent_name,
    skill_name: skill.skill_name,
    description: skill.description,
    best_for: skill.best_for,
    category: skill.category,
    price: skill.price,
    currency: skill.currency,
    marks_price: skill.marks_price,
    purchase_url: skill.purchase_url,
    reason,
  };
}

function fallbackReason(skill: Skill, queryTokens: string[]): string {
  const hits = [...new Set(queryTokens)].filter((t) =>
    skill.search_text.includes(t),
  );
  const focus = hits.length ? `your request (${hits.slice(0, 4).join(", ")})` : "your request";
  return `${skill.agent_name}'s "${skill.skill_name}" is the closest match for ${focus}: ${skill.best_for || skill.description}`;
}

interface GeminiPick {
  skill_id: string;
  reason: string;
}

async function geminiRerank(
  query: string,
  candidates: Skill[],
): Promise<GeminiPick | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  const list = candidates.map((s) => ({
    skill_id: s.skill_id,
    agent_name: s.agent_name,
    skill_name: s.skill_name,
    description: s.description,
    best_for: s.best_for,
    category: s.category,
    tags: s.tags,
    price: s.price,
    currency: s.currency,
  }));

  const prompt = `You are ClawMarket's agent-matching assistant. A user described a task. Pick the single best matching skill from the catalog candidates and explain why in one warm, concise sentence aimed at the user.

User request: "${query}"

Candidates (JSON):
${JSON.stringify(list, null, 2)}

Respond with ONLY a JSON object, no markdown, in this exact shape:
{"skill_id": "<id of the best candidate>", "reason": "<one sentence explaining why this skill fits the user's request>"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
      },
    );
    if (!res.ok) {
      console.error("Gemini call failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as GeminiPick;
    if (!parsed?.skill_id) return null;
    return parsed;
  } catch (err) {
    console.error("Gemini rerank error:", err);
    return null;
  }
}

export async function match(query: string): Promise<MatchResult> {
  const trimmed = query.trim();
  const queryTokens = tokenize(trimmed);
  console.log(`[match] query="${trimmed}" tokens=[${queryTokens.join(", ")}]`);

  // 1. Prefer Atlas Vector Search (semantic). Fall back to keyword retrieval.
  const vector = await vectorCandidates(trimmed);
  let shortlist: Skill[];
  let source: "mongodb" | "live-api";
  let retrievedByVector: boolean;

  if (vector) {
    shortlist = vector.slice(0, 6);
    source = "mongodb";
    retrievedByVector = true;
    console.log(`[match] vector search returned ${vector.length} candidates; top="${vector[0]?.skill_name}"`);
  } else {
    const candidates = await getCandidates();
    source = candidates.source;
    retrievedByVector = false;

    const ranked = [...candidates.skills]
      .map((s) => ({ skill: s, score: scoreSkill(queryTokens, s) }))
      .sort((a, b) => b.score - a.score);

    const matchedCount = ranked.filter((r) => r.score > 0).length;
    console.log(
      `[match] keyword scored ${ranked.length} skills; ${matchedCount} with score>0; ` +
        `top score=${ranked[0]?.score ?? 0} skill="${ranked[0]?.skill.skill_name ?? "(none)"}"`,
    );
    console.log(
      "[match] top 3:",
      ranked.slice(0, 3).map((r) => `${r.skill.skill_name} (${r.score})`).join(" | "),
    );

    // If nothing matched any keyword, still surface the top few so the user
    // gets a graceful answer instead of an empty screen.
    shortlist = (ranked[0]?.score > 0 ? ranked.filter((r) => r.score > 0) : ranked)
      .slice(0, 6)
      .map((r) => r.skill);
  }

  console.log(`[match] shortlist size=${shortlist.length}`);

  if (shortlist.length === 0) {
    console.log("[match] no candidates -> returning null recommendation");
    return {
      query: trimmed,
      recommendation: null,
      alternatives: [],
      source,
      ranked_by: retrievedByVector ? "vector" : "keyword",
    };
  }

  // 2. Let Gemini pick the best of the shortlist and write the "why".
  const pick = await geminiRerank(trimmed, shortlist);

  let top: Skill;
  let reason: string;
  let ranked_by: MatchResult["ranked_by"];

  if (pick) {
    top = shortlist.find((s) => s.skill_id === pick.skill_id) || shortlist[0];
    reason = pick.reason || fallbackReason(top, queryTokens);
    ranked_by = retrievedByVector ? "vector+gemini" : "gemini";
  } else {
    top = shortlist[0];
    reason = fallbackReason(top, queryTokens);
    ranked_by = retrievedByVector ? "vector" : "keyword";
  }

  const alternatives = shortlist
    .filter((s) => s.skill_id !== top.skill_id)
    .slice(0, 3)
    .map((s) => toRecommendation(s, fallbackReason(s, queryTokens)));

  console.log(`[match] result: top="${top.skill_name}" ranked_by=${ranked_by} gemini=${pick ? "yes" : "no"}`);

  return {
    query: trimmed,
    recommendation: toRecommendation(top, reason),
    alternatives,
    source,
    ranked_by,
  };
}
