export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  const body = await req.text();
  const res = await fetch(`${UPSTREAM}/projects/${params.projectId}/transcribe`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
