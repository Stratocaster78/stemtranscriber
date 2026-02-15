export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.API_INTERNAL_BASE || "http://stemtranscriber-api:8000";

function upstreamUrl(pathParts: string[]) {
  const suffix = pathParts.map(encodeURIComponent).join("/");
  return `${UPSTREAM}/files/${suffix}`;
}

export async function GET(req: Request, { params }: { params: { path: string[] } }) {
  const range = req.headers.get("range") ?? undefined;

  const res = await fetch(upstreamUrl(params.path), {
    method: "GET",
    cache: "no-store",
    headers: range ? { range } : undefined,
  });

  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "content-length": res.headers.get("content-length") ?? "",
      "content-range": res.headers.get("content-range") ?? "",
      "accept-ranges": res.headers.get("accept-ranges") ?? "",
      "content-disposition": res.headers.get("content-disposition") ?? "",
      "cache-control": "no-store",
    },
  });
}

export async function HEAD(_: Request, { params }: { params: { path: string[] } }) {
  const res = await fetch(upstreamUrl(params.path), { method: "HEAD", cache: "no-store" });
  return new Response(null, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "content-length": res.headers.get("content-length") ?? "",
      "content-range": res.headers.get("content-range") ?? "",
      "accept-ranges": res.headers.get("accept-ranges") ?? "",
      "content-disposition": res.headers.get("content-disposition") ?? "",
      "cache-control": "no-store",
    },
  });
}
