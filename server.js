import express from "express";
import fetch from "node-fetch";
import AdmZip from "adm-zip";

const app = express();
app.use(express.json());

// ✅ ADD THIS RIGHT HERE
app.get("/", (req, res) => {
  res.send("Zip processor is running");
});

app.post("/process-zip", async (req, res) => {
  try {
    const { website_order_id, repo_name, zip_url } = req.body;

    console.log("Processing:", repo_name);

    // Download ZIP
    const zipRes = await fetch(zip_url);
    const buffer = await zipRes.arrayBuffer();

    const zip = new AdmZip(Buffer.from(buffer));
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      const filePath = entry.entryName;
      const content = entry.getData();
      const base64 = content.toString("base64");

      await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${repo_name}/contents/${filePath}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github+json",
          },
          body: JSON.stringify({
            message: `Add ${filePath}`,
            content: base64,
          }),
        }
      );

      console.log("Uploaded:", filePath);
    }

    res.json({ ok: true });
  } catch (err) {
    const message = err?.stack || err?.message || String(err);
    console.error("ZIP processor error:", message);

    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));