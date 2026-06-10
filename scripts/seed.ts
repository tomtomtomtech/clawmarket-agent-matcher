// Seed MongoDB with the live ClawMarket catalog.
//   npm run seed
// Reads MONGODB_URI / MONGODB_DB / MONGODB_COLLECTION from the environment.
// Pulls real data from the ClawMarket API — nothing is mocked.

import { MongoClient } from "mongodb";
import { fetchLiveCatalog, type Skill } from "../lib/catalog";
import { EMBED_DIMENSIONS, embedBatch, embeddingsAvailable } from "../lib/embeddings";

function embedInput(s: Skill): string {
  return [
    s.skill_name,
    `By ${s.agent_name}`,
    s.best_for,
    s.description,
    s.tags.length ? `Tags: ${s.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function attachEmbeddings(skills: Skill[]): Promise<boolean> {
  if (!embeddingsAvailable()) {
    console.log("  (GEMINI_API_KEY not set — skipping embeddings; vector search will be disabled)");
    return false;
  }
  console.log("→ Generating embeddings (text-embedding-004)…");
  const inputs = skills.map(embedInput);
  const batchSize = 50;
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    vectors.push(...(await embedBatch(inputs.slice(i, i + batchSize))));
  }
  skills.forEach((s, i) => {
    s.embedding = vectors[i];
  });
  console.log(`  embedded ${vectors.length} skills (${EMBED_DIMENSIONS}-dim)`);
  return true;
}

async function ensureVectorIndex(coll: import("mongodb").Collection): Promise<void> {
  try {
    const existing = await coll.listSearchIndexes().toArray();
    const name = process.env.MONGODB_VECTOR_INDEX || "vector_index";
    if (existing.some((idx) => idx.name === name)) {
      console.log(`  vector index "${name}" already exists`);
      return;
    }
    await coll.createSearchIndex({
      name,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBED_DIMENSIONS, similarity: "cosine" },
        ],
      },
    });
    console.log(`✓ Created Atlas Vector Search index "${name}" (building in the background)`);
  } catch (err) {
    console.warn(
      "  Could not auto-create the vector index (this requires an Atlas cluster).",
    );
    console.warn("  Create it manually in Atlas → Search → Create Search Index → JSON Editor:");
    console.warn(
      JSON.stringify(
        {
          name: process.env.MONGODB_VECTOR_INDEX || "vector_index",
          type: "vectorSearch",
          definition: {
            fields: [
              { type: "vector", path: "embedding", numDimensions: EMBED_DIMENSIONS, similarity: "cosine" },
            ],
          },
        },
        null,
        2,
      ),
    );
    console.warn("  reason:", err instanceof Error ? err.message : err);
  }
}

function loadEnvFile() {
  // Minimal .env loader so the script works without extra deps.
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function main() {
  loadEnvFile();

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "clawmarket";
  const collName = process.env.MONGODB_COLLECTION || "skills";

  if (!uri) {
    console.error("✗ MONGODB_URI is not set. Add it to .env (see .env.example).");
    process.exit(1);
  }

  console.log("→ Fetching live ClawMarket catalog…");
  const skills = await fetchLiveCatalog();
  console.log(`  got ${skills.length} skills`);

  const hasEmbeddings = await attachEmbeddings(skills);

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const coll = client.db(dbName).collection(collName);

    console.log(`→ Writing to ${dbName}.${collName}…`);
    await coll.deleteMany({});
    if (skills.length) await coll.insertMany(skills);

    // Text index supports the keyword fallback; safe to re-create.
    await coll.createIndex(
      { skill_name: "text", description: "text", best_for: "text", tags: "text", agent_name: "text" },
      { name: "skill_search" },
    );
    await coll.createIndex({ skill_id: 1 }, { unique: true });

    const count = await coll.countDocuments();
    console.log(`✓ Seeded ${count} skills into ${dbName}.${collName}`);

    if (hasEmbeddings) await ensureVectorIndex(coll);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("✗ Seed failed:", err);
  process.exit(1);
});
