export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

export async function POST(req: Request) {
  const body = await req.text();
  const res = await fetch(`${UPSTREAM}/projects`, {
    method: "POST",
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body || undefined,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

export async function GET() {
  const res = await fetch(`${UPSTREAM}/projects`, { method: "GET", cache: "no-store" });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}
