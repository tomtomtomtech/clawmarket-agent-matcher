// Text embeddings via Google's embedding model (same GEMINI_API_KEY).
// Used to populate Atlas Vector Search at seed time and to embed the query at match time.

const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "text-embedding-004";
export const EMBED_DIMENSIONS = 768; // text-embedding-004 default

function apiKey(): string | null {
  return process.env.GEMINI_API_KEY || null;
}

export function embeddingsAvailable(): boolean {
  return Boolean(apiKey());
}

type TaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

/** Embed a single string. Returns null if no key or on failure. */
export async function embedText(text: string, taskType: TaskType): Promise<number[] | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
        }),
      },
    );
    if (!res.ok) {
      console.error("embedText failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const values: number[] | undefined = data?.embedding?.values;
    return Array.isArray(values) ? values : null;
  } catch (err) {
    console.error("embedText error:", err);
    return null;
  }
}

/** Embed many documents in one call (batchEmbedContents). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const key = apiKey();
  if (!key) throw new Error("GEMINI_API_KEY is required to generate embeddings");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
        })),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`batchEmbedContents -> ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const embeddings: Array<{ values: number[] }> = data?.embeddings || [];
  return embeddings.map((e) => e.values);
}
