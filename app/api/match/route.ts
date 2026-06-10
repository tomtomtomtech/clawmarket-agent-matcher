import { NextResponse } from "next/server";
import { match } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let query = "";
  try {
    const body = await req.json();
    query = typeof body?.query === "string" ? body.query : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!query.trim()) {
    return NextResponse.json({ error: "Please describe what you need." }, { status: 400 });
  }

  try {
    const result = await match(query);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Match failed:", err);
    return NextResponse.json(
      { error: "Could not reach the catalog. Please try again." },
      { status: 502 },
    );
  }
}
