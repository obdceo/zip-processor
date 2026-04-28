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
    filePath.includes(".git/") ||
    filePath.endsWith(".DS_Store")
  );
}

function findProjectRootPrefix(entries) {
  const fileNames = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName.replace(/^\/+/, ""));

  const packageJsonPath = fileNames.find((name) => name.endsWith("/package.json"));

  if (!packageJsonPath) {
    return "";
  }

  return packageJsonPath.replace(/package\.json$/, "");
}

function normalizeFilePath(entryName, rootPrefix) {
  let filePath = entryName.replace(/^\/+/, "");

  if (rootPrefix && filePath.startsWith(rootPrefix)) {
    filePath = filePath.slice(rootPrefix.length);
  }

  return filePath.replace(/^\/+/, "");
}

async function uploadFileToGitHub({ owner, repoName, filePath, content }) {
  const safePath = encodeURIComponent(filePath).replace(/%2F/g, "/");

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${safePath}`,
    {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `Add ${filePath}`,
        content: content.toString("base64"),
      }),
    }
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GitHub upload failed for ${filePath}: ${res.status} ${text}`);
  }
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

    console.log(`Uploading ${files.length} files to GitHub repo: ${repo_name}`);

    for (const { entry, filePath } of files) {
      await uploadFileToGitHub({
        owner: process.env.GITHUB_USERNAME,
        repoName: repo_name,
        filePath,
        content: entry.getData(),
      });

      console.log("Uploaded:", filePath);
    }

    try {
  await updateWebsiteOrder(website_order_id, {
    github_push_status: "pushed",
    github_pushed_at: new Date().toISOString(),
  });

  console.log("WP updated: pushed");
} catch (wpErr) {
  console.error("WP update failed:", wpErr.message);
}

    return res.status(200).json({
      ok: true,
      website_order_id,
      repo_name,
      uploaded_files: files.length,
      status: "pushed",
    });
  } catch (err) {
    const message = err?.stack || err?.message || String(err);
    console.error("ZIP processor error:", message);

    try {
      if (website_order_id) {
        await updateWebsiteOrder(website_order_id, {
          github_push_status: "failed",
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