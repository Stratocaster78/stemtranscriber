export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

export async function POST() {
  const res = await fetch(`${UPSTREAM}/jobs/demo`, { method: "POST", cache: "no-store" });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
