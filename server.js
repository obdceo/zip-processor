import express from "express";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import crypto from "node:crypto";

console.log("ZIP PROCESSOR BUILD v8 - strict Manus image integrity + CDN localization");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

class AssetResolutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AssetResolutionError";
    this.details = details;
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send("Zip processor is running");
});

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    "User-Agent": "obd-zip-processor",
  };
}

function cloudflareHeaders() {
  return {
    Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function wpAuthHeader() {
  const raw = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
  return {
    Authorization: `Basic ${Buffer.from(raw).toString("base64")}`,
  };
}

async function updateWebsiteOrder(websiteOrderId, acf) {
  const base = String(process.env.WP_BASE_URL || "").trim().replace(/\/$/, "");

  if (!base) {
    throw new Error("Missing WP_BASE_URL");
  }

  const endpoint = `${base}/wp-json/wp/v2/website_order/${websiteOrderId}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...wpAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ acf }),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`WP update failed: ${res.status} ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`WP returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

async function notifyNeedsAttention({ websiteOrderId, repoName, zipUrl, reason, missingAssets = [] }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.INTERNAL_ALERT_EMAIL;
  const from = process.env.ALERT_FROM_EMAIL || "Website Essentials <support@olivebranchdigital.com>";

  if (!apiKey || !to) {
    console.log("Needs-attention email skipped: RESEND_API_KEY or INTERNAL_ALERT_EMAIL missing");
    return;
  }

  const subject = `WE Build Needs Attention — Order #${websiteOrderId}`;

  const body = [
    `Website Essentials build needs attention.`,
    ``,
    `Order: ${websiteOrderId}`,
    `Repo: ${repoName}`,
    `ZIP URL: ${zipUrl}`,
    `Reason: ${reason}`,
    ``,
    missingAssets.length ? `Missing assets:\n${missingAssets.map((a) => `- ${a}`).join("\n")}` : "",
    ``,
    `The deployment was stopped before a broken or guessed-image site could go live.`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text: body,
    }),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("Needs-attention email failed:", res.status, text);
    return;
  }

  console.log("Needs-attention email sent");
}

function shouldSkipFile(filePath) {
  return (
    filePath.includes("node_modules/") ||
    filePath.startsWith("node_modules/") ||
    filePath.includes("/node_modules/") ||
    filePath.includes(".git/") ||
    filePath.endsWith(".DS_Store") ||
    filePath.includes(".manus-logs/")
  );
}

function isTextFileForImageRewrite(filePath) {
  return (
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".ts") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".html") ||
    filePath.endsWith(".css") ||
    filePath.endsWith(".json")
  );
}

function isImageFile(filePath) {
  return /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(filePath);
}

function sanitizeAssetFilename(filename) {
  return String(filename || "")
    .split("/")
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "-");
}

function getLocalImageFilePaths(files) {
  return files
    .map((f) => f.filePath)
    .filter((p) =>
      (p.startsWith("client/public/images/") || p.startsWith("public/images/")) &&
      isImageFile(p)
    );
}

function getAllImageFilePaths(files) {
  return files
    .map((f) => f.filePath)
    .filter((p) => isImageFile(p) && !shouldSkipFile(p));
}

function getPublicImagePathForLocalFile(filePath) {
  if (filePath.startsWith("client/public/")) {
    return `/${filePath.replace("client/public/", "")}`;
  }

  if (filePath.startsWith("public/")) {
    return `/${filePath.replace("public/", "")}`;
  }

  return filePath;
}

function getManusStorageRefsFromText(text) {
  const refs = new Set();
  const regex = /\/manus-storage\/[^"'`)\s]+?\.(jpg|jpeg|png|webp|gif|svg)/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.add(match[0]);
  }

  return [...refs];
}

function getAllManusStorageRefs(files) {
  const refs = new Set();

  for (const file of files) {
    if (!isTextFileForImageRewrite(file.filePath)) continue;

    const content = getFileContent(file);
    if (!content) continue;

    const text = content.toString("utf8");
    for (const ref of getManusStorageRefsFromText(text)) {
      refs.add(ref);
    }
  }

  return [...refs];
}

function getExternalManusCdnImageRefsFromText(text) {
  const refs = new Set();

  // Scope this rewrite to Manus CDN images only. Normal stable public URLs
  // stay untouched unless they come from the Manus artifact layer.
  const regex =
    /https:\/\/files\.manuscdn\.com\/[^"'`\s)\\]+?\.(jpg|jpeg|png|webp|gif|svg)(\?[^"'`\s)\\]*)?/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.add(match[0]);
  }

  return [...refs];
}

function getAllExternalManusCdnImageRefs(files) {
  const refs = new Set();

  for (const file of files) {
    if (!isTextFileForImageRewrite(file.filePath)) continue;

    const content = getFileContent(file);
    if (!content) continue;

    const text = content.toString("utf8");
    for (const ref of getExternalManusCdnImageRefsFromText(text)) {
      refs.add(ref);
    }
  }

  return [...refs];
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 10);
}

function filenameFromUrl(urlValue, fallbackPrefix = "manus-image") {
  try {
    const parsed = new URL(urlValue);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const clean = sanitizeAssetFilename(lastSegment);

    if (clean && isImageFile(clean)) {
      return clean;
    }
  } catch {
    // Fall through to fallback below.
  }

  return `${fallbackPrefix}-${shortHash(urlValue)}.jpg`;
}

function makeUniquePublicImagePath({ filename, existingPaths, sourceId }) {
  const extMatch = filename.match(/(\.[a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : ".jpg";
  const base = filename.replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), "");
  let localPath = `client/public/images/${filename}`;

  if (!existingPaths.has(localPath)) {
    return {
      localPath,
      publicPath: `/images/${filename}`,
    };
  }

  const hashedFilename = `${base}-${shortHash(sourceId)}${ext}`;
  localPath = `client/public/images/${hashedFilename}`;

  return {
    localPath,
    publicPath: `/images/${hashedFilename}`,
  };
}

async function fetchExternalImageUrl(imageUrl) {
  console.log("Attempting external Manus CDN image download:", imageUrl);

  const res = await fetch(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "obd-zip-processor",
    },
  });

  if (!res.ok) {
    throw new Error(`External Manus CDN image download failed: ${res.status} ${imageUrl}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const buffer = Buffer.from(await res.arrayBuffer());

  if (!contentType.startsWith("image/") && !bufferLooksLikeImage(buffer, imageUrl)) {
    throw new Error(`External Manus CDN URL did not return an image: ${contentType || "(no content-type)"} ${imageUrl}`);
  }

  if (!bufferLooksLikeImage(buffer, imageUrl)) {
    throw new Error(`External Manus CDN image failed signature check: ${imageUrl}`);
  }

  return buffer;
}

async function normalizeExternalManusCdnImageAssets({ files }) {
  const refs = getAllExternalManusCdnImageRefs(files);

  if (!refs.length) {
    console.log("No external Manus CDN image URLs found");
    return files;
  }

  console.log("Found external Manus CDN image URLs:", refs);

  const existingPaths = new Set(files.map((f) => f.filePath));
  const filesToAdd = [];
  const refToPublicPath = new Map();
  const unresolved = [];

  for (const ref of refs) {
    try {
      const downloaded = await fetchExternalImageUrl(ref);
      const originalFilename = filenameFromUrl(ref, "manus-cdn-image");
      const extMatch = originalFilename.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1] : ".jpg";
      const base = originalFilename.replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), "");
      const filename = `${base}-${shortHash(ref)}${ext}`;

      const { localPath, publicPath } = makeUniquePublicImagePath({
        filename,
        existingPaths,
        sourceId: ref,
      });

      if (!existingPaths.has(localPath)) {
        filesToAdd.push({
          entry: null,
          filePath: localPath,
          content: downloaded,
          generated: true,
          copiedFrom: ref,
        });

        existingPaths.add(localPath);
      }

      refToPublicPath.set(ref, publicPath);
      console.log(`Localized external Manus CDN image ${ref} -> ${localPath}`);
    } catch (err) {
      console.log("External Manus CDN image localization failed:", err?.message || String(err));
      unresolved.push(ref);
    }
  }

  if (unresolved.length) {
    throw new AssetResolutionError(
      `Unresolved external Manus CDN image assets. Refusing to deploy remote/ephemeral images: ${unresolved.join(", ")}`,
      {
        unresolved,
        assetResolutionPolicy: "strict_exact_recovered_or_cdn_localized",
      }
    );
  }

  const normalizedFiles = files.map((file) => {
    if (!isTextFileForImageRewrite(file.filePath)) {
      return file;
    }

    const originalContent = getFileContent(file);
    if (!originalContent) return file;

    let text = originalContent.toString("utf8");
    let changed = false;

    for (const [ref, publicPath] of refToPublicPath.entries()) {
      if (text.includes(ref)) {
        text = text.split(ref).join(publicPath);
        changed = true;
        console.log(`Rewrote external Manus CDN image in ${file.filePath}: ${ref} -> ${publicPath}`);
      }
    }

    if (!changed) return file;

    return {
      ...file,
      content: Buffer.from(text, "utf8"),
    };
  });

  console.log("External Manus CDN image localization complete.");

  return [...normalizedFiles, ...filesToAdd];
}

function deriveAssetBaseUrl({ zipUrl, assetBaseUrl }) {
  const candidates = deriveAssetBaseUrls({ zipUrl, assetBaseUrl });
  return candidates[0] || "";
}

function deriveAssetBaseUrls({ zipUrl, assetBaseUrl }) {
  const candidates = [];

  const addCandidate = (value) => {
    const clean = String(value || "").trim().replace(/\/$/, "");
    if (clean && !candidates.includes(clean)) {
      candidates.push(clean);
    }
  };

  if (assetBaseUrl) {
    String(assetBaseUrl)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .forEach(addCandidate);
  }

  try {
    const url = new URL(zipUrl);

    // Runtime Manus URLs often look like:
    // https://3000-xxxxx.us2.manus.computer/manus-storage/site-source.zip
    // In that case, the same origin can sometimes serve /manus-storage/image.jpg.
    if (url.hostname.includes("manus.computer") || url.hostname.includes("manus.space")) {
      addCandidate(url.origin);
    }
  } catch (err) {
    console.log("Could not derive asset base URL from ZIP URL:", err.message);
  }

  // Last-resort probe. If Manus returns HTML/404, image signature checks below block it.
  addCandidate("https://manus.im");

  return candidates;
}

function getFileContent(file) {
  if (!file) return null;
  if (file.content) return file.content;
  if (file.entry) return file.entry.getData();
  return null;
}

function createLocalImageIndex(files) {
  const byExactName = new Map();

  for (const filePath of getAllImageFilePaths(files)) {
    const filename = filePath.split("/").pop();
    const file = files.find((f) => f.filePath === filePath);
    const alreadyPublic =
      filePath.startsWith("client/public/") ||
      filePath.startsWith("public/");

    const record = {
      file,
      filePath,
      filename,
      alreadyPublic,
      publicPath: alreadyPublic ? getPublicImagePathForLocalFile(filePath) : `/images/${sanitizeAssetFilename(filename)}`,
    };

    byExactName.set(filename.toLowerCase(), record);
  }

  return { byExactName };
}

function findLocalImageMatch(localImageIndex, ref) {
  const filename = sanitizeAssetFilename(ref);

  // Strict production rule:
  // Only exact filename matches are allowed for /manus-storage/ references.
  // No fuzzy matching. No backup-image matching. No guessed substitutions.
  return localImageIndex.byExactName.get(filename.toLowerCase()) || null;
}

function bufferLooksLikeImage(buffer, ref = "") {
  if (!buffer || buffer.length < 4) return false;

  const lowerRef = String(ref || "").toLowerCase();

  if (lowerRef.endsWith(".svg")) {
    const head = buffer.toString("utf8", 0, Math.min(buffer.length, 200)).trim().toLowerCase();
    return head.startsWith("<svg") || head.includes("<svg");
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true; // jpg

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) return true; // png

  if (buffer.toString("ascii", 0, 3) === "GIF") return true;

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) return true;

  return false;
}

async function fetchManusAsset({ assetBaseUrls, assetBaseUrl, ref }) {
  const candidates = assetBaseUrls?.length ? assetBaseUrls : assetBaseUrl ? [assetBaseUrl] : [];

  for (const baseUrl of candidates) {
    if (!baseUrl) continue;

    const assetUrl = `${String(baseUrl).replace(/\/$/, "")}${ref}`;

    console.log("Attempting Manus asset download:", assetUrl);

    const res = await fetch(assetUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "obd-zip-processor",
      },
    });

    if (!res.ok) {
      console.log("Manus asset download failed:", res.status, assetUrl);
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    const buffer = Buffer.from(await res.arrayBuffer());

    if (!contentType.startsWith("image/") && !bufferLooksLikeImage(buffer, ref)) {
      console.log("Manus asset was not an image:", contentType, assetUrl);
      continue;
    }

    if (!bufferLooksLikeImage(buffer, ref)) {
      console.log("Downloaded Manus asset failed image signature check:", assetUrl);
      continue;
    }

    return buffer;
  }

  return null;
}

async function normalizeManusImageAssets({ files, zipUrl, assetBaseUrl }) {
  const refs = getAllManusStorageRefs(files);

  if (!refs.length) {
    console.log("No /manus-storage/ image references found");
    return files;
  }

  console.log("Found Manus image references:", refs);

  const resolvedAssetBaseUrls = deriveAssetBaseUrls({ zipUrl, assetBaseUrl });
  const resolvedAssetBaseUrl = resolvedAssetBaseUrls[0] || "";
  let localImageIndex = createLocalImageIndex(files);

  const existingPaths = new Set(files.map((f) => f.filePath));
  const filesToAdd = [];
  const refToPublicPath = new Map();
  const unresolved = [];

  for (const ref of refs) {
    const filename = sanitizeAssetFilename(ref);
    const localMatch = findLocalImageMatch(localImageIndex, ref);

    if (localMatch) {
      if (localMatch.alreadyPublic) {
        refToPublicPath.set(ref, localMatch.publicPath);
        console.log(`Using exact public ZIP image for ${ref}: ${localMatch.publicPath}`);
        continue;
      }

      const sourceContent = getFileContent(localMatch.file);

      if (sourceContent && bufferLooksLikeImage(sourceContent, localMatch.filename)) {
        const localPath = `client/public/images/${filename}`;
        const publicPath = `/images/${filename}`;

        if (!existingPaths.has(localPath)) {
          filesToAdd.push({
            entry: null,
            filePath: localPath,
            content: sourceContent,
            generated: true,
            copiedFrom: localMatch.filePath,
          });

          existingPaths.add(localPath);
          console.log(`Copied exact ZIP-local image ${localMatch.filePath} -> ${localPath}`);
        }

        refToPublicPath.set(ref, publicPath);
        continue;
      }

      console.log(`Exact local image match had no usable image bytes for ${ref}: ${localMatch.filePath}`);
    }

    const downloaded = await fetchManusAsset({
      assetBaseUrls: resolvedAssetBaseUrls,
      ref,
    });

    if (downloaded) {
      const localPath = `client/public/images/${filename}`;
      const publicPath = `/images/${filename}`;

      if (!existingPaths.has(localPath)) {
        filesToAdd.push({
          entry: null,
          filePath: localPath,
          content: downloaded,
          generated: true,
        });

        existingPaths.add(localPath);
      }

      refToPublicPath.set(ref, publicPath);

      console.log(`Downloaded and staged Manus image ${ref} -> ${localPath}`);
      continue;
    }

    unresolved.push(ref);
  }

  if (unresolved.length) {
    throw new AssetResolutionError(
      `Unresolved Manus image assets. Refusing to deploy guessed/broken images: ${unresolved.join(", ")}`,
      {
        unresolved,
        assetBaseUrl: resolvedAssetBaseUrl,
        assetBaseUrls: resolvedAssetBaseUrls,
        assetResolutionPolicy: "strict_exact_or_recovered",
      }
    );
  }

  const normalizedFiles = files.map((file) => {
    if (!isTextFileForImageRewrite(file.filePath)) {
      return file;
    }

    const originalContent = getFileContent(file);
    if (!originalContent) return file;

    let text = originalContent.toString("utf8");
    let changed = false;

    for (const [ref, publicPath] of refToPublicPath.entries()) {
      if (text.includes(ref)) {
        text = text.split(ref).join(publicPath);
        changed = true;
        console.log(`Rewrote image ref in ${file.filePath}: ${ref} -> ${publicPath}`);
      }
    }

    if (!changed) return file;

    return {
      ...file,
      content: Buffer.from(text, "utf8"),
    };
  });

  console.log("Strict image integrity check passed. No fallback/backup image substitution used.");

  return [...normalizedFiles, ...filesToAdd];
}

function findProjectRootPrefix(entries) {
  const fileNames = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName.replace(/^\/+/, ""))
    .filter((name) => !name.includes("node_modules/"));

  // Best case: package.json is already at ZIP root
  if (fileNames.includes("package.json")) {
    return "";
  }

  // Common Manus export: one top-level folder containing package.json
  const packageJsonPaths = fileNames.filter((name) => name.endsWith("/package.json"));

  const preferred = packageJsonPaths.find((name) => {
    const parts = name.split("/");
    return parts.length === 2;
  });

  if (preferred) {
    return preferred.replace(/package\.json$/, "");
  }

  return "";
}

function normalizeFilePath(entryName, rootPrefix) {
  let filePath = entryName.replace(/^\/+/, "");

  if (rootPrefix && filePath.startsWith(rootPrefix)) {
    filePath = filePath.slice(rootPrefix.length);
  }

  return filePath.replace(/^\/+/, "");
}

function detectFramework(files) {
  const filePaths = files.map((f) => f.filePath);

  const hasPackageJson = filePaths.includes("package.json");
  const hasIndexHtml = filePaths.includes("index.html");
  const hasAstroConfig = filePaths.some((p) =>
    p.startsWith("astro.config")
  );
  const hasNextConfig = filePaths.some((p) =>
    p.startsWith("next.config")
  );

  if (!hasPackageJson && hasIndexHtml) {
    return {
      framework: "static",
      build_command: null,
      output_dir: "/",
    };
  }

  if (hasAstroConfig) {
    return {
      framework: "astro",
      build_command: "npm run build",
      output_dir: "dist",
    };
  }

  if (hasNextConfig) {
    return {
      framework: "next-static",
      build_command: "npm run build && npm run export",
      output_dir: "out",
    };
  }

  return {
    framework: "vite",
    build_command: "pnpm install --no-frozen-lockfile && pnpm run build",
    output_dir: "dist/public",
  };
}

async function ensureGitHubRepo(repoName) {
  const owner = process.env.GITHUB_USERNAME;

  const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    method: "GET",
    headers: githubHeaders(),
  });

  if (checkRes.ok) {
    console.log("GitHub repo already exists:", repoName);
    return;
  }

  if (checkRes.status !== 404) {
    const text = await checkRes.text();
    throw new Error(`GitHub repo check failed: ${checkRes.status} ${text}`);
  }

  const createRes = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false,
    }),
  });

  const text = await createRes.text();

  if (!createRes.ok) {
    throw new Error(`GitHub repo create failed: ${createRes.status} ${text}`);
  }

  console.log("GitHub repo created:", repoName);
}

async function getExistingGitHubFileSha({ owner, repoName, filePath }) {
  const safePath = encodeURIComponent(filePath).replace(/%2F/g, "/");

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${safePath}`,
    {
      method: "GET",
      headers: githubHeaders(),
    }
  );

  if (res.status === 404) {
    return null;
  }

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GitHub SHA lookup failed for ${filePath}: ${res.status} ${text}`);
  }

  const json = JSON.parse(text);
  return json.sha || null;
}

async function uploadFileToGitHub({ owner, repoName, filePath, content }) {
  const safePath = encodeURIComponent(filePath).replace(/%2F/g, "/");

  const existingSha = await getExistingGitHubFileSha({
    owner,
    repoName,
    filePath,
  });

  const body = {
    message: existingSha ? `Update ${filePath}` : `Add ${filePath}`,
    content: content.toString("base64"),
  };

  if (existingSha) {
    body.sha = existingSha;
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${safePath}`,
    {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify(body),
    }
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GitHub upload failed for ${filePath}: ${res.status} ${text}`);
  }
}

async function createCloudflarePagesProject({
  repoName,
  productionBranch,
  buildCommand,
  outputDir,
}) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/pages/projects`,
    {
      method: "POST",
      headers: cloudflareHeaders(),
      body: JSON.stringify({
        name: repoName,
        production_branch: productionBranch,
        build_config: {
          build_command: buildCommand,
          destination_dir: outputDir,
        },
        source: {
          type: "github",
          config: {
            owner: process.env.GITHUB_USERNAME,
            repo_name: repoName,
            production_branch: productionBranch,
          },
        },
      }),
    }
  );

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Cloudflare Pages create failed: ${JSON.stringify(json)}`);
  }

  return json.result;
}

async function triggerCloudflarePagesDeployment(projectName) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/pages/projects/${projectName}/deployments`,
    {
      method: "POST",
      headers: cloudflareHeaders(),
      body: JSON.stringify({}),
    }
  );

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Cloudflare Pages deployment trigger failed: ${JSON.stringify(json)}`);
  }

  console.log("Cloudflare Pages deployment triggered:", projectName);

  return json.result;
}

app.post("/process-zip", async (req, res) => {
  const { website_order_id, repo_name, zip_url, asset_base_url } = req.body || {};

  try {
    if (!website_order_id || !repo_name || !zip_url) {
      return res.status(400).json({
        ok: false,
        error: "Missing website_order_id, repo_name, or zip_url",
      });
    }

    if (!process.env.GITHUB_USERNAME || !process.env.GITHUB_TOKEN) {
      throw new Error("Missing GitHub credentials");
    }

    console.log("Processing ZIP for:", repo_name);
    console.log("Downloading ZIP:", zip_url);

    const zipRes = await fetch(zip_url);

    if (!zipRes.ok) {
      const text = await zipRes.text();
      throw new Error(`ZIP download failed: ${zipRes.status} ${text}`);
    }

    const buffer = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    const rootPrefix = findProjectRootPrefix(entries);

    console.log("Detected root prefix:", rootPrefix || "(none)");

    let files = entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => {
        const filePath = normalizeFilePath(entry.entryName, rootPrefix);
        return {
          entry,
          filePath,
          content: entry.getData(),
          generated: false,
        };
      })
      .filter(({ filePath }) => filePath && !shouldSkipFile(filePath));

    files = await normalizeManusImageAssets({
      files,
      zipUrl: zip_url,
      assetBaseUrl: asset_base_url,
    });

    files = await normalizeExternalManusCdnImageAssets({
      files,
    });

    await ensureGitHubRepo(repo_name);

    console.log(`Uploading ${files.length} files to GitHub repo: ${repo_name}`);

    for (const { content, entry, filePath } of files) {
      const uploadContent = content || entry.getData();

      await uploadFileToGitHub({
        owner: process.env.GITHUB_USERNAME,
        repoName: repo_name,
        filePath,
        content: uploadContent,
      });

      console.log("Uploaded:", filePath);
    }

    await uploadFileToGitHub({
      owner: process.env.GITHUB_USERNAME,
      repoName: repo_name,
      filePath: ".npmrc",
      content: Buffer.from(
        "legacy-peer-deps=true\nauto-install-peers=true\nstrict-peer-dependencies=false\nfrozen-lockfile=false\n",
        "utf8"
      ),
    });

    console.log("Uploaded: .npmrc");

    const buildConfig = detectFramework(files);

    console.log("Detected framework:", buildConfig.framework);

    const pagesProject = await createCloudflarePagesProject({
      repoName: repo_name,
      productionBranch: "main",
      buildCommand: buildConfig.build_command,
      outputDir: buildConfig.output_dir,
    });

    const pagesDeployment = await triggerCloudflarePagesDeployment(pagesProject.name);

    const previewUrl = `https://${pagesProject.subdomain}`;

    try {
      await updateWebsiteOrder(website_order_id, {
        github_push_status: "pushed",
        github_pushed_at: new Date().toISOString(),
        deployment_provider: "cloudflare_pages",
        deployment_status: "deployed",
        deployed_preview_url: previewUrl,
        cloudflare_project_name: pagesProject.name,
        asset_resolution_policy: "strict_exact_recovered_or_cdn_localized",
      });

      console.log("WP updated: pushed and deployed");
    } catch (wpErr) {
      console.error("WP update failed:", wpErr.message);
    }

    return res.status(200).json({
      ok: true,
      website_order_id,
      repo_name,
      uploaded_files: files.length,
      status: "deployed",
      framework: buildConfig.framework,
      deployed_preview_url: previewUrl,
      cloudflare_project: pagesProject.name,
      cloudflare_deployment_id: pagesDeployment.id,
    });
  } catch (err) {
    const message = err?.stack || err?.message || String(err);
    console.error("ZIP processor error:", message);

    const isAssetError = err instanceof AssetResolutionError;
    const deploymentStatus = isAssetError ? "needs_attention" : "failed";

    try {
      if (website_order_id) {
        await updateWebsiteOrder(website_order_id, {
          github_push_status: isAssetError ? "blocked" : "failed",
          deployment_status: deploymentStatus,
          // Keep order_status within allowed ACF select values and avoid false "complete" states.
          order_status: "needs_attention",
          deployment_error: err?.message || String(err),
        });
      }
    } catch (wpErr) {
      console.error("Failed to update WP after error:", wpErr?.message || String(wpErr));
    }

    if (isAssetError) {
      await notifyNeedsAttention({
        websiteOrderId: website_order_id,
        repoName: repo_name,
        zipUrl: zip_url,
        reason: err.message,
        missingAssets: err.details?.unresolved || [],
      });
    }

    return res.status(500).json({
      ok: false,
      status: deploymentStatus,
      error: message,
      unresolved_assets: isAssetError ? err.details?.unresolved || [] : undefined,
      asset_base_url_used: isAssetError ? err.details?.assetBaseUrl || "" : undefined,
      asset_resolution_policy: "strict_exact_recovered_or_cdn_localized",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Zip processor running on port ${PORT}`);
});
