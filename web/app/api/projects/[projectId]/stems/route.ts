export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  const res = await fetch(`${UPSTREAM}/projects/${params.projectId}/stems`, {
    cache: "no-store",
    headers: { "cache-control": "no-store" },
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
