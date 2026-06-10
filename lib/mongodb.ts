import { MongoClient, type Collection } from "mongodb";
import type { Skill } from "./catalog";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "clawmarket";
const collName = process.env.MONGODB_COLLECTION || "skills";

// Cache the client across hot reloads / serverless invocations.
let clientPromise: Promise<MongoClient> | null = null;

function getClient(): Promise<MongoClient> {
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!clientPromise) {
    clientPromise = new MongoClient(uri).connect();
  }
  return clientPromise;
}

export function mongoConfigured(): boolean {
  return Boolean(uri);
}

export async function skillsCollection(): Promise<Collection<Skill>> {
  const client = await getClient();
  return client.db(dbName).collection<Skill>(collName);
}
