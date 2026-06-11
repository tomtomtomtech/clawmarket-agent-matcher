"use client";

import { useRef, useState } from "react";

interface Recommendation {
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

interface MatchResult {
  query: string;
  recommendation: Recommendation | null;
  alternatives: Recommendation[];
  source: "mongodb" | "live-api";
  ranked_by: "vector+gemini" | "vector" | "gemini" | "keyword" | "agent";
}

function rankedByLabel(ranked: MatchResult["ranked_by"]): string {
  switch (ranked) {
    case "agent":
      return "ADK agent + MongoDB MCP";
    case "vector+gemini":
      return "Atlas Vector Search + Gemini";
    case "vector":
      return "Atlas Vector Search";
    case "gemini":
      return "Gemini";
    default:
      return "keyword relevance";
  }
}

const SUGGESTIONS = [
  "I need a blockchain project audit.",
  "Review my investor pitch deck.",
  "Help me write a better ending for my book.",
  "Analyze my website.",
];

function priceLabel(r: Recommendation): string {
  if (r.currency === "USDC" && r.price && r.price > 0) return `${r.price} USDC`;
  if (r.currency === "MARKS" && r.marks_price && r.marks_price > 0)
    return `${r.marks_price} MARKS`;
  return "Free";
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runSearch(q: string) {
    const text = q.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      setResult(data as MatchResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query);
  }

  function useSuggestion(s: string) {
    setQuery(s);
    inputRef.current?.focus();
    runSearch(s);
  }

  const rec = result?.recommendation;

  return (
    <main className="page">
      <header className="hero">
        <div className="logo">
          <img src="/logo.png" alt="Agent Matcher by ClawMarket" style={{height: "80px", width: "auto"}} />
        </div>
        <h1>Agent Matcher</h1>
        <p className="tagline">
          Describe your task in plain English. We&apos;ll find the right AI agent on
          ClawMarket — with pricing and a direct purchase link.
        </p>
      </header>

      <form className="search" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="e.g. I need someone to audit my blockchain project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Describe your task"
        />
        <button className="search-btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? "Matching…" : "Find my agent"}
        </button>
      </form>

      {!result && !loading && (
        <div className="suggestions">
          <span className="suggestions-label">Try:</span>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => useSuggestion(s)} type="button">
              {s}
            </button>
          ))}
        </div>
      )}

      {loading && <div className="status">Searching the live ClawMarket catalog…</div>}
      {error && <div className="status error">{error}</div>}

      {result && !rec && (
        <div className="status">
          No close match found for “{result.query}”. Try describing the task differently.
        </div>
      )}

      {rec && (
        <section className="result">
          <div className="result-meta">
            Best match for “{result!.query}” · {rankedByLabel(result!.ranked_by)} · source:{" "}
            {result!.source === "mongodb" ? "MongoDB Atlas" : "live API"}
          </div>

          <article className="card primary">
            <div className="card-head">
              <div>
                <div className="agent">{rec.agent_name}</div>
                <div className="skill">{rec.skill_name}</div>
              </div>
              <div className="price">{priceLabel(rec)}</div>
            </div>
            {rec.category && <span className="badge">{rec.category}</span>}
            <p className="reason">{rec.reason}</p>
            {rec.description && <p className="desc">{rec.description}</p>}
            <a className="buy" href={rec.purchase_url} target="_blank" rel="noopener noreferrer">
              View &amp; purchase on ClawMarket →
            </a>
          </article>

          {result!.alternatives.length > 0 && (
            <>
              <h2 className="alt-title">Other options</h2>
              <div className="alt-grid">
                {result!.alternatives.map((a) => (
                  <article key={a.purchase_url} className="card alt">
                    <div className="card-head">
                      <div>
                        <div className="agent small">{a.agent_name}</div>
                        <div className="skill small">{a.skill_name}</div>
                      </div>
                      <div className="price small">{priceLabel(a)}</div>
                    </div>
                    {a.best_for && <p className="desc">{a.best_for}</p>}
                    <a className="buy ghost" href={a.purchase_url} target="_blank" rel="noopener noreferrer">
                      View →
                    </a>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <footer className="foot">
        Powered by Google Cloud Agent Builder · Gemini · MongoDB Atlas
      </footer>
    </main>
  );
}
