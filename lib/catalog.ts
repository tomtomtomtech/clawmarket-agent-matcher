// Live ClawMarket catalog access + normalization.
// Real data only — pulled from the public ClawMarket API. No mocked records.

export interface Skill {
  skill_id: string;
  slug: string;
  agent_id: string;
  agent_name: string;
  skill_name: string;
  description: string;
  best_for: string;
  category: string;
  tags: string[];
  price: number | null; // USDC
  currency: string; // "USDC" | "MARKS" | "FREE"
  marks_price: number | null;
  skill_type: string | null;
  rating_avg: number | null;
  rating_count: number | null;
  purchase_url: string;
  // Concatenated, lowercased text used for keyword scoring + Atlas text index.
  search_text: string;
  // Populated by the seed script for Atlas Vector Search (text-embedding-004, 768-dim).
  embedding?: number[];
}

interface RawService {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  best_for: string | null;
  tags: string[] | null;
  price_base_usdc: number | null;
  marks_price: number | null;
  agent_id: string;
  active: boolean | null;
  skill_type: string | null;
  rating_avg: number | null;
  rating_count: number | null;
}

interface RawAgent {
  id: string;
  name: string;
}

const BASE = process.env.CLAWMARKET_BASE_URL || "https://clawmarketai.com";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // Always hit the network — the catalog is the source of truth.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

function deriveCurrency(priceUsdc: number | null, marks: number | null): string {
  if (priceUsdc && priceUsdc > 0) return "USDC";
  if (marks && marks > 0) return "MARKS";
  return "FREE";
}

function normalize(svc: RawService, agentName: string): Skill {
  const tags = (svc.tags || []).filter(Boolean);
  const description = (svc.description || "").trim();
  const best_for = (svc.best_for || "").trim();
  const search_text = [svc.title, agentName, description, best_for, tags.join(" ")]
    .join(" ")
    .toLowerCase();

  return {
    skill_id: svc.id,
    slug: svc.slug,
    agent_id: svc.agent_id,
    agent_name: agentName,
    skill_name: svc.title,
    description,
    best_for,
    category: tags[0] || svc.skill_type || "general",
    tags,
    price: svc.price_base_usdc,
    currency: deriveCurrency(svc.price_base_usdc, svc.marks_price),
    marks_price: svc.marks_price,
    skill_type: svc.skill_type,
    rating_avg: svc.rating_avg ?? null,
    rating_count: svc.rating_count ?? null,
    purchase_url: `${BASE}/skills/${svc.slug}`,
    search_text,
  };
}

/** Fetch and normalize the full live catalog (all active skills + agent names). */
export async function fetchLiveCatalog(): Promise<Skill[]> {
  const [services, agents] = await Promise.all([
    getJSON<{ items: RawService[]; total: number }>(`${BASE}/services?page_size=200`),
    getJSON<RawAgent[]>(`${BASE}/agents`),
  ]);

  const agentNames = new Map(agents.map((a) => [a.id, a.name]));

  return services.items
    .filter((s) => s.active !== false)
    .map((s) => normalize(s, agentNames.get(s.agent_id) || "Unknown Agent"));
}
