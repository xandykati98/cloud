import { mkdir, rename, unlink, stat, readFile } from "node:fs/promises";
import { join, resolve, normalize, sep } from "node:path";
import { platform, release, arch } from "node:os";
import checkDiskSpace from "check-disk-space";

const STORAGE_ROOT = process.env.STORAGE_ROOT ?? join(process.cwd(), "storage");

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveSafe(relativePath: string): string {
  const normalized = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const root = resolve(STORAGE_ROOT);
  const full = resolve(root, normalized);
  const allowed = full === root || full.startsWith(root + sep);
  if (!allowed) {
    throw new Error("Path traversal not allowed");
  }
  return full;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

async function handleDisk(): Promise<Response> {
  try {
    const diskSpace = await checkDiskSpace(STORAGE_ROOT);
    return jsonResponse({
      path: diskSpace.diskPath,
      freeBytes: diskSpace.free,
      sizeBytes: diskSpace.size,
      freeGb: Math.round((diskSpace.free / 1024 ** 3) * 100) / 100,
      sizeGb: Math.round((diskSpace.size / 1024 ** 3) * 100) / 100,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(`Disk space check failed: ${message}`, 500);
  }
}

function handleOs(): Response {
  return jsonResponse({
    platform,
    release: release(),
    arch: arch(),
  });
}

async function handleUpload(request: Request): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return errorResponse("Content-Type must be multipart/form-data", 400);
  }
  try {
    const formData = await request.formData();
    const pathParam = formData.get("path");
    const file = formData.get("file");
    if (typeof pathParam !== "string" || pathParam === "") {
      return errorResponse("Missing or invalid form field: path", 400);
    }
    if (!(file instanceof File)) {
      return errorResponse("Missing or invalid form field: file", 400);
    }
    const targetPath = resolveSafe(pathParam);
    await mkdir(resolve(targetPath, ".."), { recursive: true });
    await Bun.write(targetPath, file);
    return jsonResponse({ path: pathParam, size: file.size });
  } catch (err) {
    if (err instanceof Error && err.message === "Path traversal not allowed") {
      return errorResponse("Path traversal not allowed", 400);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(`Upload failed: ${message}`, 500);
  }
}

async function handleRename(request: Request): Promise<Response> {
  if (request.headers.get("Content-Type")?.includes("application/json") !== true) {
    return errorResponse("Content-Type must be application/json", 400);
  }
  try {
    const body = (await request.json()) as { from?: string; to?: string };
    const from = body.from;
    const to = body.to;
    if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "") {
      return errorResponse("Body must include 'from' and 'to' paths", 400);
    }
    const fromPath = resolveSafe(from);
    const toPath = resolveSafe(to);
    await rename(fromPath, toPath);
    return jsonResponse({ from, to });
  } catch (err) {
    if (err instanceof Error && err.message === "Path traversal not allowed") {
      return errorResponse("Path traversal not allowed", 400);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(`Rename failed: ${message}`, 500);
  }
}

async function handleDownload(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathParam = url.searchParams.get("path");
  if (!pathParam) {
    return errorResponse("Query parameter 'path' is required", 400);
  }
  try {
    const filePath = resolveSafe(pathParam);
    const st = await stat(filePath);
    if (!st.isFile()) {
      return errorResponse("Path is not a file", 400);
    }
    const file = Bun.file(filePath);
    const name = pathParam.split(/[/\\]/).pop() ?? "download";
    return new Response(file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Path traversal not allowed") {
      return errorResponse("Path traversal not allowed", 400);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(`Download failed: ${message}`, 500);
  }
}

async function handleDelete(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathParam = url.searchParams.get("path");
  if (!pathParam) {
    return errorResponse("Query parameter 'path' is required", 400);
  }
  try {
    const filePath = resolveSafe(pathParam);
    const st = await stat(filePath);
    if (!st.isFile()) {
      return errorResponse("Path is not a file", 400);
    }
    await unlink(filePath);
    return jsonResponse({ deleted: pathParam });
  } catch (err) {
    if (err instanceof Error && err.message === "Path traversal not allowed") {
      return errorResponse("Path traversal not allowed", 400);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(`Delete failed: ${message}`, 500);
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if ((pathname === "/dev-ui" || pathname === "/dev-ui/") && method === "GET") {
    try {
      const htmlPath = join(process.cwd(), "index.html");
      const html = await readFile(htmlPath, "utf-8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch {
      return errorResponse("Dev UI not found", 404);
    }
  }

  if (pathname === "/api/disk" && method === "GET") return withCors(await handleDisk());
  if (pathname === "/api/os" && method === "GET") return withCors(handleOs());
  if (pathname === "/api/upload" && method === "POST") return withCors(await handleUpload(request));
  if (pathname === "/api/rename" && method === "PATCH") return withCors(await handleRename(request));
  if (pathname === "/api/download" && method === "GET") return withCors(await handleDownload(request));
  if (pathname === "/api/file" && method === "DELETE") return withCors(await handleDelete(request));

  return withCors(errorResponse("Not Found", 404));
}

const server = Bun.serve({
  port: process.env.PORT ? Number(process.env.PORT) : 4444,
  fetch: handleRequest,
});

console.log(`Storage API listening on http://localhost:${server.port}`);
console.log(`Storage root: ${STORAGE_ROOT}`);
