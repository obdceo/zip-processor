import express from "express";
import fetch from "node-fetch";
import AdmZip from "adm-zip";

console.log("ZIP PROCESSOR BUILD v4");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

  return JSON.parse(text);
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
    filePath.endsWith(".css")
  );
}

function isImageFilePath(filePath) {
  return /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(filePath);
}

function getPublicImageFilename(filePath) {
  return filePath.split("/").pop();
}

function getZipOrigin(zipUrl) {
  try {
    return new URL(zipUrl).origin;
  } catch {
    return "";
  }
}

function sanitizeImageFilename(filename) {
  return String(filename || "")
    .split("/")
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "-");
}

function getManusStorageImageRefsFromText(content) {
  const text = content.toString("utf8");
  const refs = new Set();
  const regex = /\/manus-storage\/[^"'`)\s]+?\.(jpg|jpeg|png|webp|gif|svg)/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    refs.add(match[0]);
  }

  return Array.from(refs);
}

function rewriteImageReferences(content, filePath, imageReferenceMap) {
  if (!isTextFileForImageRewrite(filePath)) {
    return content;
  }

  let text = content.toString("utf8");

  for (const [originalRef, replacementRef] of imageReferenceMap.entries()) {
    text = text.split(originalRef).join(replacementRef);
  }

  return Buffer.from(text, "utf8");
}

async function downloadImageBuffer(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      "User-Agent": "obd-zip-processor",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image download failed: ${res.status} ${url} ${text.slice(0, 200)}`);
  }

  const contentType = res.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    throw new Error(`Image URL did not return an image: ${url} (${contentType})`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function normalizeManusImageAssets({ files, zipUrl }) {
  const localImages = files
    .map((f) => f.filePath)
    .filter((filePath) =>
      isImageFilePath(filePath) &&
      (
        filePath.startsWith("client/public/images/") ||
        filePath.startsWith("public/images/")
      )
    );

  const localImageByFilename = new Map();

  for (const imagePath of localImages) {
    const filename = getPublicImageFilename(imagePath);
    if (filename) {
      localImageByFilename.set(filename.toLowerCase(), imagePath);
    }
  }

  const manuscriptRefs = new Set();

  for (const { entry, filePath } of files) {
    if (!isTextFileForImageRewrite(filePath)) continue;

    for (const ref of getManusStorageImageRefsFromText(entry.getData())) {
      manuscriptRefs.add(ref);
    }
  }

  const imageReferenceMap = new Map();
  const generatedImages = [];
  const unresolvedRefs = [];
  const zipOrigin = getZipOrigin(zipUrl);

  console.log("Local exported images detected:", localImages.length);
  console.log("Manus storage image references detected:", manuscriptRefs.size);

  for (const ref of manuscriptRefs) {
    const rawFilename = sanitizeImageFilename(ref);
    const filename = rawFilename || `image-${generatedImages.length + 1}.jpg`;
    const localMatchPath = localImageByFilename.get(filename.toLowerCase());

    if (localMatchPath) {
      imageReferenceMap.set(ref, `/images/${filename}`);
      console.log(`Mapped Manus image to exported local asset: ${ref} -> /images/${filename}`);
      continue;
    }

    if (!zipOrigin) {
      unresolvedRefs.push(ref);
      continue;
    }

    const remoteUrl = `${zipOrigin}${ref}`;

    try {
      const imageBuffer = await downloadImageBuffer(remoteUrl);
      const targetPath = `client/public/images/${filename}`;

      generatedImages.push({
        filePath: targetPath,
        content: imageBuffer,
        sourceUrl: remoteUrl,
      });

      imageReferenceMap.set(ref, `/images/${filename}`);
      console.log(`Downloaded missing Manus image: ${remoteUrl} -> ${targetPath}`);
    } catch (err) {
      console.error(`Could not resolve Manus image ${ref}:`, err?.message || String(err));
      unresolvedRefs.push(ref);
    }
  }

  if (unresolvedRefs.length > 0) {
    throw new Error(
      `Unresolved Manus image assets. Refusing to deploy guessed/broken images: ${unresolvedRefs.join(", ")}`
    );
  }

  return {
    imageReferenceMap,
    generatedImages,
    localImageCount: localImages.length,
    manusImageRefCount: manuscriptRefs.size,
  };
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
  const { website_order_id, repo_name, zip_url } = req.body || {};

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

    const files = entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => {
        const filePath = normalizeFilePath(entry.entryName, rootPrefix);
        return { entry, filePath };
      })
      .filter(({ filePath }) => filePath && !shouldSkipFile(filePath));

await ensureGitHubRepo(repo_name);

const imageNormalization = await normalizeManusImageAssets({
  files,
  zipUrl: zip_url,
});

    console.log(`Uploading ${files.length} files to GitHub repo: ${repo_name}`);

    for (const { entry, filePath } of files) {
  const originalContent = entry.getData();

const uploadContent = rewriteImageReferences(
  originalContent,
  filePath,
  imageNormalization.imageReferenceMap
);

  await uploadFileToGitHub({
    owner: process.env.GITHUB_USERNAME,
    repoName: repo_name,
    filePath,
    content: uploadContent,
  });

  console.log("Uploaded:", filePath);
}

for (const image of imageNormalization.generatedImages) {
  await uploadFileToGitHub({
    owner: process.env.GITHUB_USERNAME,
    repoName: repo_name,
    filePath: image.filePath,
    content: image.content,
  });

  console.log("Uploaded downloaded image:", image.filePath);
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

  try {
    if (website_order_id) {
      await updateWebsiteOrder(website_order_id, {
        github_push_status: "failed",
        deployment_status: "failed",
      });
    }
  } catch (wpErr) {
    console.error("Failed to update WP after error:", wpErr?.message || String(wpErr));
  }

  return res.status(500).json({
    ok: false,
    error: message,
  });
}
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Zip processor running on port ${PORT}`);
});