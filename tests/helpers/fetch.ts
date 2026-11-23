import JSZip from "jszip";

export interface FetchCall {
  url: string;
  init: RequestInit;
  body: any;
}

const originalFetch = globalThis.fetch;

export function installFetchMock(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; mock: typeof fetch } {
  const calls: FetchCall[] = [];
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url, init: init || {}, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  globalThis.fetch = mock;
  return { calls, mock };
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function binaryResponse(
  data: Uint8Array,
  contentType = "application/octet-stream",
  status = 200,
): Response {
  return new Response(data, {
    status,
    headers: { "Content-Type": contentType },
  });
}

export function sseResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export async function zipResponse(
  files: Record<string, Uint8Array>,
): Promise<Response> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return binaryResponse(bytes, "application/zip");
}

export function msgpackResponse(data: Uint8Array): Response {
  return binaryResponse(data, "application/x-msgpack");
}
