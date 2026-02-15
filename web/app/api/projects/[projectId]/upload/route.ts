export const runtime = "nodejs";
const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  const formData = await req.formData();
  const res = await fetch(`${UPSTREAM}/projects/${params.projectId}/upload`, {
    method: "POST",
    body: formData
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" }
  });
}
