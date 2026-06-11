// Text embeddings via Google's embedding model (same GEMINI_API_KEY).
// Used to populate Atlas Vector Search at seed time and to embed the query at match time.

const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
export const EMBED_DIMENSIONS = 768; // requested via outputDimensionality

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
          outputDimensionality: EMBED_DIMENSIONS,
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

/** Embed many documents. gemini-embedding-001 only supports single embedContent,
 *  so we call it per-document with bounded concurrency. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const key = apiKey();
  if (!key) throw new Error("GEMINI_API_KEY is required to generate embeddings");

  const results: number[][] = new Array(texts.length);
  const CONCURRENCY = 5;
  let cursor = 0;

  async function worker() {
    while (cursor < texts.length) {
      const i = cursor++;
      const vec = await embedText(texts[i], "RETRIEVAL_DOCUMENT");
      if (!vec) throw new Error(`embedContent failed for document ${i}`);
      results[i] = vec;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return results;
}
