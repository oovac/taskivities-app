// Demo uploads. Nothing a visitor uploads is kept: an image is stored as SAMPLE_PNG and any other file as SAMPLE_PDF,
// under the visitor's own file name. Done in two places, so the app's attachment code runs unchanged:
//   • demoUpload() swaps the bytes of an upload request before the app sees it (so size and type match the sample);
//   • demoFiles() stands in for the R2 bucket: it stores nothing and reads back the sample that matches the type
//     (this also covers files AI assistants attach over MCP, which don't arrive as an upload request).
import type { Env } from '../worker/lib';
import { SAMPLE_PDF, SAMPLE_PNG, SAMPLE_TEXT } from './samples';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic|bmp|svg|tiff?)$/i;

const sampleFor = (type: string | null | undefined) =>
  type?.startsWith('image/') ? SAMPLE_PNG : type?.startsWith('text/') ? SAMPLE_TEXT : SAMPLE_PDF;

/** An upload request (app or one-time upload link) with its body replaced by the sample. */
export async function demoUpload(req: Request): Promise<Request> {
  await req.body?.cancel().catch(() => undefined); // don't read what was sent
  const url = new URL(req.url);
  const name = decodeURIComponent(url.searchParams.get('name') ?? req.headers.get('x-file-name') ?? '');
  const image = req.headers.get('content-type')?.startsWith('image/') || IMAGE_EXT.test(name);
  const bytes = image ? SAMPLE_PNG : SAMPLE_PDF;
  const headers = new Headers(req.headers);
  headers.set('content-type', image ? 'image/png' : 'application/pdf');
  headers.set('content-length', String(bytes.byteLength));
  return new Request(req.url, { method: req.method, headers, body: bytes });
}

/** A stand-in R2 bucket: put() keeps nothing, get() returns the sample for the attachment's type. */
export function demoFiles(env: Env): R2Bucket {
  const object = (bytes: Uint8Array, type: string) => ({
    get body() { return new Response(bytes).body; },
    size: bytes.byteLength,
    httpMetadata: { contentType: type },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
    bytes: async () => bytes,
  });
  return {
    async put(_key: string, value: unknown) {
      if (value instanceof ReadableStream) await value.pipeTo(new WritableStream()); // drain it so the upload completes
      return {};
    },
    async get(key: string) {
      const row = await env.DB.prepare('SELECT type FROM attachments WHERE key = ?').bind(key).first<{ type: string }>();
      if (!row) return null;
      return object(sampleFor(row.type), row.type);
    },
    async delete() {},
  } as unknown as R2Bucket;
}
