export const runtime = "nodejs";

const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

export async function GET(req: Request, { params }: { params: { projectId: string; filename: string } }) {
  const range = req.headers.get("range") ?? undefined;

  const res = await fetch(`${UPSTREAM}/files/${params.projectId}/stems/${params.filename}`, {
    headers: range ? { range } : undefined,
  });

  // Forward key headers (especially for audio streaming)
  const headers = new Headers();
  const ct = res.headers.get("content-type");
  const cl = res.headers.get("content-length");
  const cr = res.headers.get("content-range");
  const ar = res.headers.get("accept-ranges");
  const cd = res.headers.get("content-disposition");

  if (ct) headers.set("content-type", ct);
  if (cl) headers.set("content-length", cl);
  if (cr) headers.set("content-range", cr);
  if (ar) headers.set("accept-ranges", ar);
  if (cd) headers.set("content-disposition", cd);

  // Caching off while developing (avoids weirdness across projects)
  headers.set("cache-control", "no-store");

  return new Response(res.body, {
    status: res.status, // could be 200 or 206
    headers,
  });
}
