const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = process.cwd();
const WRITABLE_ROOT = process.env.VERCEL === "1" ? "/tmp" : ROOT;
const DATA_DIR = path.join(WRITABLE_ROOT, "data");
const GENERATED_DIR = path.join(WRITABLE_ROOT, "generated");
const PUBLIC_DIR = path.join(ROOT, "public");

const PROFILE_FILE = path.join(DATA_DIR, "profile.json");
const PROFILES_DIR = path.join(DATA_DIR, "profiles");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const CHUNKS_FILE = path.join(DATA_DIR, "chunks.json");

const mkdirSync = require("fs").mkdirSync;
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(GENERATED_DIR, { recursive: true });
mkdirSync(PROFILES_DIR, { recursive: true });

app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/generated", express.static(GENERATED_DIR));

// Architecture-level features
const responseCache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

app.get("/api/health", async (req, res) => {
  const mode = getMode();
  const embeddingMode = getEmbeddingMode();
  res.json({
    mode,
    model: process.env.LLM_MODEL || (mode === "mock" ? "mock" : "remote"),
    embeddingMode,
    embeddingModel:
      embeddingMode === "remote"
        ? process.env.LLM_EMBEDDINGS_MODEL || "auto"
        : "hash-256"
  });
});

app.get("/api/profile", async (req, res) => {
  const profile = await getProfile();
  res.json(profile);
});

app.get("/api/profiles", async (req, res) => {
  const profiles = await listProfiles();
  res.json(profiles);
});

app.get("/api/profile/:slug", async (req, res) => {
  const profile = await readJson(profilePath(req.params.slug), null);
  if (!profile) {
    return res.status(404).json({ error: "Profile not found" });
  }
  res.json(profile);
});

app.delete("/api/profile/:slug", async (req, res) => {
  const slug = req.params.slug;
  try {
    await fs.unlink(profilePath(slug));
    const rmDir = path.join(GENERATED_DIR, slug);
    await fs.rm(rmDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.post("/api/profile/:slug/duplicate", async (req, res) => {
  const slug = req.params.slug;
  const existing = await readJson(profilePath(slug), null);
  if (!existing) {
    return res.status(404).json({ error: "Profile not found" });
  }
  const newSlug = await uniqueSlug(existing.name + " copy");
  const profile = { ...existing, slug: newSlug, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  profile.systemPrompt = buildSystemPrompt(profile);
  await writeJson(profilePath(newSlug), profile);
  await writeJson(PROFILE_FILE, profile);
  const notes = await getNotes();
  const chunks = await getChunks();
  const generated = await writeGenerated(profile, notes, chunks);
  const instructions = buildInstructions(profile, generated.slug);
  res.json({
    ...profile,
    generated: { ...generated, instructions, previewUrl: profile.buildType === "website" ? `/generated/${generated.slug}/index.html` : null }
  });
});

app.post("/api/profile", async (req, res) => {
  const input = sanitizeProfile(req.body || {});
  if (!input.persona || !input.specialization) {
    return res.status(400).json({ error: "persona and specialization are required" });
  }

  const existingSlug = input.slug ? safeSlug(input.slug) : null;
  let profile;
  let now = new Date().toISOString();

  if (existingSlug) {
    const existing = await readJson(profilePath(existingSlug), null);
    profile = {
      ...defaultProfile(),
      ...existing,
      ...input,
      slug: existingSlug,
      updatedAt: now
    };
    if (!profile.createdAt) profile.createdAt = now;
  } else {
    const slug = await uniqueSlug(input.name || input.specialization);
    profile = {
      ...defaultProfile(),
      ...input,
      slug,
      updatedAt: now,
      createdAt: now
    };
  }
  profile.systemPrompt = buildSystemPrompt(profile);

  await writeJson(profilePath(profile.slug), profile);
  await writeJson(PROFILE_FILE, profile);
  const notes = await getNotes();
  const chunks = await getChunks();
  const generated = await writeGenerated(profile, notes, chunks);
  const instructions = buildInstructions(profile, generated.slug);

  res.json({
    ...profile,
    generated: {
      ...generated,
      instructions,
      previewUrl: profile.buildType === "website" ? `/generated/${generated.slug}/index.html` : null
    }
  });
});

app.get("/api/notes", async (req, res) => {
  const notes = await getNotes();
  res.json(notes);
});

app.get("/api/chunks", async (req, res) => {
  const chunks = await getChunks();
  const docs = summarizeDocs(chunks);
  res.json({ docs, chunksCount: chunks.length });
});

app.post("/api/train", async (req, res) => {
  const { title, content, source } = req.body || {};
  if (!content || String(content).trim().length < 10) {
    return res.status(400).json({ error: "content must be at least 10 characters" });
  }

  const notes = await getNotes();
  const note = {
    id: crypto.randomUUID(),
    title: String(title || "Training Note"),
    source: String(source || "").trim(),
    content: String(content),
    createdAt: new Date().toISOString()
  };
  notes.unshift(note);
  await writeJson(NOTES_FILE, notes);

  const chunks = await getChunks();
  const noteChunks = await indexTextAsChunks({
    docId: note.id,
    docType: "note",
    title: note.title,
    source: note.source,
    content: note.content
  });
  chunks.unshift(...noteChunks);
  await writeJson(CHUNKS_FILE, chunks);

  const profile = await getProfile();
  await writeGenerated(profile, notes, chunks);

  res.json({ ok: true, note });
});

app.post("/api/ingest", async (req, res) => {
  const { title, content, source } = req.body || {};
  if (!content || String(content).trim().length < 30) {
    return res.status(400).json({ error: "content must be at least 30 characters" });
  }

  const docId = crypto.randomUUID();
  const docTitle = String(title || "Document").trim();
  const docSource = String(source || "").trim();

  const chunks = await getChunks();
  const newChunks = await indexTextAsChunks({
    docId,
    docType: "document",
    title: docTitle,
    source: docSource,
    content: String(content)
  });
  chunks.unshift(...newChunks);
  await writeJson(CHUNKS_FILE, chunks);

  const profile = await getProfile();
  const notes = await getNotes();
  await writeGenerated(profile, notes, chunks);

  res.json({ ok: true, docId, chunks: newChunks.length });
});

app.post("/api/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message || String(message).trim().length === 0) {
    return res.status(400).json({ error: "message is required" });
  }

  const profile = await getProfile();
  const notes = await getNotes();
  const chunks = await getChunks();
  const topChunks = await getTopChunks(chunks, String(message));
  const mode = getMode();
  const architecture = profile.architecture || "single";

  // Sustainable: check response cache first
  if (architecture === "sustainable") {
    const cacheKey = getCacheKey(message, profile);
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({
        reply: cached,
        mode: "cache",
        architecture: "sustainable",
        usedSources: formatSources(topChunks)
      });
    }
  }

  // Multi-LLM: classify task and pick model
  let modelOverride;
  let taskType = "default";
  if (architecture === "multi-llm" && mode === "remote") {
    taskType = classifyTask(message);
    modelOverride = getModelForTask(taskType);
  }

  try {
    let reply = "";
    let usedMode = mode;

    if (mode === "remote") {
      reply = await callRemoteModel({
        profile,
        message: String(message),
        chunks: topChunks,
        model: modelOverride
      });
    } else {
      reply = buildMockReply({
        profile,
        message: String(message),
        chunks: topChunks
      });
      usedMode = "mock";
    }

    // Sustainable: cache the response
    if (architecture === "sustainable") {
      const cacheKey = getCacheKey(message, profile);
      setCached(cacheKey, reply);
    }

    const extra = {};
    if (modelOverride) {
      extra.taskType = taskType;
      extra.modelUsed = modelOverride;
    }

    res.json({
      reply,
      mode: usedMode,
      architecture,
      ...extra,
      usedSources: formatSources(topChunks)
    });
  } catch (err) {
    const fallback = buildMockReply({
      profile,
      message: String(message),
      chunks: topChunks
    });
    res.json({
      reply: fallback,
      mode: "mock",
      architecture,
      warning: "Remote model failed. Returned mock response.",
      usedSources: formatSources(topChunks)
    });
  }
});

app.get("/api/export", async (req, res) => {
  const profile = await getProfile();
  const notes = await getNotes();
  const chunks = await getChunks();
  const generated = await writeGenerated(profile, notes, chunks);
  const zipName = `${generated.slug}-platform.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=\"${zipName}\"`);

  const archiver = require("archiver");
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create archive" });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  archive.directory(generated.dir, false);
  archive.finalize();
});

app.post("/api/reset", async (req, res) => {
  const profile = defaultProfile();
  profile.systemPrompt = buildSystemPrompt(profile);
  await writeJson(PROFILE_FILE, profile);
  await writeJson(NOTES_FILE, []);
  await writeJson(CHUNKS_FILE, []);
  await writeGenerated(profile, [], []);
  res.json({ ok: true });
});

async function startServer(preferredPort) {
  const url = `http://localhost:${preferredPort}`;
  const border = "=".repeat(50);
  const server = app.listen(preferredPort, () => {
    console.log(`\n  ${border}`);
    console.log(`  ${url}`);
    console.log(`  AI Platform Builder`);
    console.log(`  ${border}\n`);
    console.log(`  Build your own AI — choose Agent, Website, or Desktop App`);
    console.log(`  Press Ctrl+C to stop\n`);

    cp.exec(`open "${url}"`, () => {});
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const next = preferredPort + 1;
      console.log("  Port " + preferredPort + " busy, trying " + next + "...");
      server.close(() => startServer(next));
    } else {
      console.error("  Server error: " + err.message);
      process.exit(1);
    }
  });

  process.on("SIGINT", () => { console.log("\n  Goodbye.\n"); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\n  Goodbye.\n"); process.exit(0); });
}

function getMode() {
  if (process.env.LLM_MODE) {
    return process.env.LLM_MODE === "remote" ? "remote" : "mock";
  }
  if (process.env.LLM_API_BASE && process.env.LLM_API_KEY) {
    return "remote";
  }
  return "mock";
}

function getEmbeddingMode() {
  if (process.env.LLM_EMBEDDINGS_MODE) {
    return process.env.LLM_EMBEDDINGS_MODE === "remote" ? "remote" : "local";
  }
  if (process.env.LLM_API_BASE && process.env.LLM_API_KEY) {
    return "remote";
  }
  return "local";
}

function sanitizeProfile(input) {
  return {
    name: String(input.name || "Custom AI"),
    persona: String(input.persona || "").trim(),
    specialization: String(input.specialization || "").trim(),
    tone: String(input.tone || "Direct, helpful, concise"),
    goals: String(input.goals || "").trim(),
    constraints: String(input.constraints || "").trim(),
    buildType: ["agent", "website", "desktop"].includes(input.buildType) ? input.buildType : "agent",
    architecture: ["single", "multi-llm", "sustainable"].includes(input.architecture) ? input.architecture : "single",
    slug: input.slug ? String(input.slug).trim() : undefined
  };
}

function defaultProfile() {
  const now = new Date().toISOString();
  return {
    name: "Custom AI",
    persona: "A practical specialist who explains things clearly.",
    specialization: "General AI platform prototype",
    tone: "Direct, helpful, concise",
    goals: "Provide accurate, useful guidance in the chosen domain.",
    constraints: "Be transparent about uncertainty and ask clarifying questions.",
    buildType: "agent",
    architecture: "single",
    createdAt: now,
    updatedAt: now,
    systemPrompt: ""
  };
}

function buildSystemPrompt(profile) {
  const lines = [
    `You are ${profile.name}.`,
    `Specialization: ${profile.specialization}.`,
    `Persona: ${profile.persona}.`,
    `Tone: ${profile.tone}.`,
    profile.goals ? `Goals: ${profile.goals}.` : "",
    profile.constraints ? `Constraints: ${profile.constraints}.` : "",
    "Use the provided training notes and indexed documents when relevant.",
    "If information is missing or ambiguous, ask a clarifying question.",
    "Be transparent about uncertainty and avoid fabricating sources."
  ];

  if (profile.architecture === "multi-llm") {
    lines.push("You operate in a multi-LLM environment. Route complex analytical queries to deep reasoning, simple factual queries to quick retrieval, and creative tasks to generative exploration.");
  }

  if (profile.architecture === "sustainable") {
    lines.push("This system runs on sustainable architecture. Responses should be concise, efficient, and minimize computational overhead. Prefer local context over remote model calls when possible.");
  }

  return lines.filter(Boolean).join("\n");
}

function buildInstructions(profile, slug) {
  if (profile.buildType === "website") {
    return {
      title: "Website Generated",
      steps: [
        `Open the preview link below to see your site`,
        `Or open generated/${slug}/index.html directly`,
        "Edit the HTML to customize colors, text, and layout"
      ],
      files: ["index.html", "profile.json"]
    };
  }
  if (profile.buildType === "desktop") {
    return {
      title: "Desktop App Generated",
      steps: [
        `cd generated/${slug}`,
        "npm install",
        "npm start",
        "Launches an Electron window with your AI's chat interface"
      ],
      files: ["main.js", "preload.js", "index.html", "package.json"]
    };
  }
  return {
    title: "AI Agent Generated",
    steps: [
      `Check generated/${slug}/agent.js for the runtime export`,
      `Review generated/${slug}/SYSTEM_PROMPT.md for the full prompt`,
      `Test the agent in the chat panel below`,
      "Add training notes to improve responses"
    ],
    files: ["agent.js", "SYSTEM_PROMPT.md", "knowledge.json"]
  };
}

function classifyTask(message) {
  const msg = message.toLowerCase();
  const analytical = /analyze|compare|evaluate|assess|why|how.*work|explain|reason|implications/i;
  const creative = /create|design|write|generate|imagine|draft|compose|brainstorm|suggest.*idea/i;
  const simple = /what is|who is|when|where|define|list|tell me|summarize|yes|no/i;

  if (analytical.test(msg)) return "analytical";
  if (creative.test(msg)) return "creative";
  if (simple.test(msg)) return "simple";
  return "default";
}

function getModelForTask(taskType) {
  const models = {
    simple: process.env.LLM_MODEL_SIMPLE || process.env.LLM_MODEL || "gpt-4o-mini",
    analytical: process.env.LLM_MODEL_ANALYTICAL || process.env.LLM_MODEL || "gpt-4o",
    creative: process.env.LLM_MODEL_CREATIVE || process.env.LLM_MODEL || "gpt-4o",
    default: process.env.LLM_MODEL || "gpt-4o"
  };
  return models[taskType] || models.default;
}

function getCacheKey(message, profile) {
  const hash = crypto.createHash("sha256").update(`${message}::${profile.name}`).digest("hex");
  return hash;
}

function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  responseCache.set(key, { value, ts: Date.now() });
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

async function getTopChunks(chunks, query) {
  if (!chunks.length) {
    return [];
  }

  const queryEmbedding = await resolveQueryEmbedding(chunks, query);
  const scored = chunks
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding || [])
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!scored.length) {
    return [];
  }

  return scored.map((entry) => entry.chunk);
}

function makeSnippet(text, limit) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, limit - 1)}…`;
}

function formatSources(chunks) {
  return chunks.map((chunk) => ({
    id: chunk.id,
    title: chunk.title,
    type: chunk.docType,
    snippet: makeSnippet(chunk.content, 160)
  }));
}

function buildMockReply({ profile, message, chunks }) {
  const contextBlock = chunks.length
    ? `Using ${chunks.length} source(s) from your knowledge base:\n${chunks
        .map((chunk) => `  • ${chunk.title} (${chunk.docType})`)
        .join("\n")}`
    : "No knowledge base entries matched your query.";

  const hints = [];
  if (process.env.LLM_API_BASE && process.env.LLM_API_KEY) {
    hints.push(`Set LLM_MODE=remote for real AI responses`);
  } else {
    hints.push(`Set LLM_API_BASE + LLM_API_KEY to connect a real model`);
  }
  if (profile.buildType === "desktop") {
    hints.push(`Generated app ready in generated/${safeSlug(profile.name)}`);
  } else if (profile.buildType === "website") {
    hints.push(`Preview your site at /generated/${safeSlug(profile.name)}/index.html`);
  }

  return [
    `🤖 ${profile.name} — ${profile.specialization}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `**Mock Mode** — no remote model connected.`,
    ``,
    `Your request: "${makeSnippet(message, 120)}"`,
    ``,
    contextBlock,
    ``,
    `System prompt preview:`,
    makeSnippet(profile.systemPrompt, 200),
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ...hints.map((h) => `🔧 ${h}`)
  ].join("\n");
}

async function callRemoteModel({ profile, message, chunks, model: modelOverride }) {
  const base = normalizeBase(process.env.LLM_API_BASE || "");
  const apiKey = process.env.LLM_API_KEY || "";
  const model = modelOverride || process.env.LLM_MODEL || "auto";
  const temperature = Number(process.env.LLM_TEMPERATURE || 0.4);

  if (!base || !apiKey) {
    throw new Error("Missing remote model configuration");
  }

  const context = chunks.length
    ? `Indexed Context:\n${chunks
        .map((chunk) => `- ${chunk.title}: ${makeSnippet(chunk.content, 240)}`)
        .join("\n")}`
    : "";

  const messages = [
    { role: "system", content: profile.systemPrompt },
    ...(context ? [{ role: "system", content: context }] : []),
    { role: "user", content: message }
  ];

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Remote model error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Remote model returned empty content");
  }
  return String(content).trim();
}

async function embedText(text) {
  const mode = getEmbeddingMode();
  if (mode === "remote") {
    try {
      return await callRemoteEmbedding(text);
    } catch (err) {
      return localEmbedding(text);
    }
  }
  return localEmbedding(text);
}

async function resolveQueryEmbedding(chunks, query) {
  const reference = chunks.find((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length);
  const expectedDim = reference ? reference.embedding.length : 0;
  let queryEmbedding = await embedText(query);

  if (expectedDim && queryEmbedding.length !== expectedDim) {
    if (expectedDim === 256) {
      queryEmbedding = localEmbedding(query);
    } else {
      try {
        queryEmbedding = await callRemoteEmbedding(query);
      } catch (err) {
        return queryEmbedding;
      }
    }
  }

  return queryEmbedding;
}

async function callRemoteEmbedding(text) {
  const base = normalizeBase(process.env.LLM_API_BASE || "");
  const apiKey = process.env.LLM_API_KEY || "";
  const model = process.env.LLM_EMBEDDINGS_MODEL || "auto";

  if (!base || !apiKey) {
    throw new Error("Missing remote embeddings configuration");
  }

  const response = await fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: truncateText(text, 4000)
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Remote embeddings error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("Remote embeddings returned empty vector");
  }
  return embedding;
}

function localEmbedding(text) {
  const dims = 256;
  const vector = new Array(dims).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = hashToken(token) % dims;
    vector[index] += 1;
  }
  return normalizeVector(vector);
}

function hashToken(token) {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a, b) {
  if (!a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function truncateText(text, limit) {
  const cleaned = String(text || "").trim();
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return cleaned.slice(0, limit);
}

function normalizeBase(base) {
  if (!base) {
    return "";
  }
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function chunkText(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const chunkSize = 200;
  const overlap = 40;
  const chunks = [];

  if (!words.length) {
    return chunks;
  }

  for (let start = 0; start < words.length; start += chunkSize - overlap) {
    const slice = words.slice(start, start + chunkSize);
    if (slice.length) {
      chunks.push(slice.join(" "));
    }
  }

  return chunks;
}

async function indexTextAsChunks({ docId, docType, title, source, content }) {
  const now = new Date().toISOString();
  const segments = chunkText(content);
  const chunks = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const embedding = await embedText(segment);
    chunks.push({
      id: crypto.randomUUID(),
      docId,
      docType,
      title,
      source,
      content: segment,
      embedding,
      chunkIndex: index,
      chunkTotal: segments.length,
      createdAt: now
    });
  }

  return chunks;
}

function summarizeDocs(chunks) {
  const docs = new Map();

  for (const chunk of chunks) {
    if (!docs.has(chunk.docId)) {
      docs.set(chunk.docId, {
        docId: chunk.docId,
        title: chunk.title,
        source: chunk.source,
        type: chunk.docType,
        chunkCount: 0,
        createdAt: chunk.createdAt
      });
    }
    docs.get(chunk.docId).chunkCount += 1;
  }

  return Array.from(docs.values()).sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || "")
  );
}

async function getProfile() {
  const profile = await readJson(PROFILE_FILE, null);
  if (profile) {
    return profile;
  }
  const fresh = defaultProfile();
  fresh.systemPrompt = buildSystemPrompt(fresh);
  await writeJson(PROFILE_FILE, fresh);
  return fresh;
}

async function getNotes() {
  const notes = await readJson(NOTES_FILE, null);
  if (notes) {
    return notes;
  }
  await writeJson(NOTES_FILE, []);
  return [];
}

async function getChunks() {
  const chunks = await readJson(CHUNKS_FILE, null);
  if (chunks) {
    return chunks;
  }
  await writeJson(CHUNKS_FILE, []);
  return [];
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

async function writeJson(file, data) {
  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(file, `${payload}\n`, "utf8");
}

function profilePath(slug) {
  return path.join(PROFILES_DIR, `${slug}.json`);
}

async function listProfiles() {
  try {
    const entries = await fs.readdir(PROFILES_DIR);
    const slugs = entries.filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
    const profiles = await Promise.all(
      slugs.map(s => readJson(profilePath(s), null))
    );
    return profiles
      .filter(Boolean)
      .map((p, i) => ({ ...p, slug: slugs[i] }))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  } catch {
    return [];
  }
}

async function uniqueSlug(base) {
  let slug = safeSlug(base);
  const existing = (await listProfiles()).map(p => p.slug);
  if (!existing.includes(slug)) return slug;
  let i = 1;
  while (existing.includes(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

async function writeGenerated(profile, notes, chunks) {
  const slug = safeSlug(profile.name || profile.specialization);
  const dir = path.join(GENERATED_DIR, slug);
  await ensureDir(dir);

  await writeJson(path.join(dir, "profile.json"), profile);
  await writeJson(path.join(dir, "knowledge.json"), notes);
  await writeJson(path.join(dir, "chunks.json"), chunks);
  await fs.writeFile(path.join(dir, "SYSTEM_PROMPT.md"), `${profile.systemPrompt}\n`, "utf8");

  if (profile.buildType === "website") {
    await generateWebsite(profile, dir);
  } else if (profile.buildType === "desktop") {
    await generateDesktopApp(profile, dir);
  } else {
    const agentModule = [
      "// Auto-generated. Edit in the builder UI instead.",
      `export const profile = ${JSON.stringify(profile, null, 2)};`,
      "export const systemPrompt = profile.systemPrompt;"
    ].join("\n");
    await fs.writeFile(path.join(dir, "agent.js"), `${agentModule}\n`, "utf8");
  }

  const readme = (() => {
    const header = `# ${profile.name} - ${profile.buildType === "website" ? "Website" : profile.buildType === "desktop" ? "Desktop App" : "AI Agent"}`;
    const common = [
      "",
      `Build type: ${profile.buildType}`,
      `Architecture: ${profile.architecture}`,
      "",
      "- profile.json: your AI definition",
    ];
    if (profile.buildType === "website") {
      return [header, ...common, "- index.html: generated website (open in browser)"].join("\n");
    }
    if (profile.buildType === "desktop") {
      return [header, ...common, "- main.js: Electron main process", "- index.html: desktop UI", "- preload.js: secure bridge", "", "## Run", "", "```bash", "npm install", "npm start", "```"].join("\n");
    }
    return [header, ...common, "- knowledge.json: training notes", "- chunks.json: indexed document chunks", "- SYSTEM_PROMPT.md: the live system prompt", "- agent.js: small runtime export"].join("\n");
  })();
  await fs.writeFile(path.join(dir, "README.md"), `${readme}\n`, "utf8");

  return { slug, dir };
}

async function generateWebsite(profile, dir) {
  const archLabel = { single: "Single LLM", "multi-llm": "Multi-LLM Routing", sustainable: "Sustainable (Efficient)" }[profile.architecture] || "Single LLM";
  const features = [
    `Specialized in ${escHtml(profile.specialization)}`,
    escHtml(profile.goals || "Expert-level guidance"),
    `Architecture: ${archLabel}`
  ];

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(profile.name)} - ${escHtml(profile.specialization)}</title>
  <style>
    :root { color-scheme:dark; --bg:#0d1516; --card:rgba(255,255,255,0.07); --stroke:rgba(255,255,255,0.15); --text:#f4f2ea; --muted:#c3c7bd; --accent:#ffb357; --accent-2:#56c4b2; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:system-ui,-apple-system,sans-serif; background:radial-gradient(circle at top,#1d2c2b,var(--bg)); color:var(--text); min-height:100vh; line-height:1.6; }
    .container { max-width:1100px; margin:0 auto; padding:0 24px; }
    header { padding:80px 0 40px; text-align:center; }
    .badge { display:inline-flex; background:rgba(255,179,87,0.15); color:var(--accent); border:1px solid rgba(255,179,87,0.3); padding:6px 14px; border-radius:999px; font-size:.85rem; text-transform:uppercase; letter-spacing:.2em; font-weight:600; }
    h1 { font-size:clamp(2.8rem,5vw,4rem); margin:24px 0 16px; }
    .subtitle { color:var(--muted); font-size:1.25rem; max-width:640px; margin:0 auto; }
    .arch-badge { display:inline-block; background:rgba(86,196,178,0.15); color:var(--accent-2); border:1px solid rgba(86,196,178,0.3); padding:4px 12px; border-radius:999px; font-size:.8rem; margin-top:16px; }
    section { background:var(--card); border:1px solid var(--stroke); border-radius:18px; padding:32px; margin-bottom:24px; backdrop-filter:blur(12px); }
    h2 { font-size:1.6rem; margin-bottom:16px; }
    .features { display:grid; gap:12px; }
    .features li { list-style:none; padding:12px 16px; background:rgba(0,0,0,0.3); border-radius:12px; border:1px solid rgba(255,255,255,0.1); }
    .constraints { color:var(--muted); font-size:.95rem; }
    footer { text-align:center; color:var(--muted); padding:40px 0; font-size:.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge">${escHtml(profile.specialization)}</div>
      <h1>${escHtml(profile.name)}</h1>
      <p class="subtitle">${escHtml(profile.persona)}</p>
      <div class="arch-badge">${archLabel}</div>
    </header>
    <main>
      <section>
        <h2>About</h2>
        <p>${escHtml(profile.goals || "Focused on delivering expert-level guidance in " + profile.specialization + ".")}</p>
      </section>
      <section>
        <h2>Capabilities</h2>
        <ul class="features">
          ${features.map(function(f) { return "<li>" + f + "</li>"; }).join("\n          ")}
        </ul>
      </section>
      <section>
        <h2>Operating Principles</h2>
        <p class="constraints">${escHtml(profile.constraints || "Built with clarity and reliability in mind.")}</p>
      </section>
    </main>
    <footer>
      <p>${profile.architecture} architecture</p>
    </footer>
  </div>
</body>
</html>`;

  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
}

async function generateDesktopApp(profile, dir) {
  const archLabel = { single: "Single LLM", "multi-llm": "Multi-LLM Routing", sustainable: "Sustainable (Efficient)" }[profile.architecture] || "Single LLM";
  const slug = safeSlug(profile.name);

  const pkg = JSON.stringify({
    name: `ai-${slug}`,
    version: "1.0.0",
    private: true,
    main: "main.js",
    scripts: {
      start: "electron .",
      dev: "electron ."
    },
    dependencies: {
      electron: "^33.0.0"
    }
  }, null, 2);

  const mainJs = [
    `const { app, BrowserWindow } = require('electron');`,
    `const path = require('path');`,
    ``,
    `function createWindow() {`,
    `  const win = new BrowserWindow({`,
    `    width: 900,`,
    `    height: 700,`,
    `    minWidth: 600,`,
    `    minHeight: 500,`,
    `    title: ${JSON.stringify(profile.name)},`,
    `    backgroundColor: '#0d1516',`,
    `    webPreferences: {`,
    `      preload: path.join(__dirname, 'preload.js'),`,
    `      contextIsolation: true,`,
    `      nodeIntegration: false`,
    `    }`,
    `  });`,
    `  win.loadFile('index.html');`,
    `}`,
    ``,
    `app.whenReady().then(createWindow);`,
    `app.on('window-all-closed', () => {`,
    `  if (process.platform !== 'darwin') app.quit();`,
    `});`,
    `app.on('activate', () => {`,
    `  if (BrowserWindow.getAllWindows().length === 0) createWindow();`,
    `});`
  ].join("\n");

  const preloadJs = [
    `const { contextBridge } = require('electron');`,
    `const profile = ${JSON.stringify(profile, null, 2)};`,
    `contextBridge.exposeInMainWorld('ai', {`,
    `  profile,`,
    `  systemPrompt: ${JSON.stringify(profile.systemPrompt)}`,
    `});`
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(profile.name)} - ${escHtml(profile.specialization)}</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    :root { color-scheme:dark; --bg:#0d1516; --card:rgba(255,255,255,0.07); --stroke:rgba(255,255,255,0.15); --text:#f4f2ea; --muted:#c3c7bd; --accent:#ffb357; --accent-2:#56c4b2; }
    body { font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
    header { padding:14px 20px; border-bottom:1px solid var(--stroke); background:rgba(0,0,0,0.3); -webkit-app-region:drag; flex-shrink:0; }
    header h1 { font-size:1.1rem; }
    header p { font-size:.8rem; color:var(--muted); }
    .badge { display:inline-block; background:rgba(255,179,87,0.15); color:var(--accent); border:1px solid rgba(255,179,87,0.3); padding:2px 10px; border-radius:999px; font-size:.65rem; text-transform:uppercase; letter-spacing:.1em; font-weight:600; margin-top:4px; }
    #chatLog { flex:1; overflow-y:auto; padding:16px 20px; display:flex; flex-direction:column; gap:10px; }
    .bubble { padding:10px 14px; border-radius:14px; border:1px solid var(--stroke); background:rgba(8,15,15,0.75); font-size:.9rem; white-space:pre-wrap; max-width:85%; line-height:1.5; }
    .bubble.user { align-self:flex-end; border-color:rgba(255,179,87,0.35); background:rgba(255,179,87,0.12); }
    .bubble.agent { align-self:flex-start; }
    .bubble.meta { align-self:center; font-size:.75rem; color:var(--muted); }
    .input-area { padding:12px 20px; border-top:1px solid var(--stroke); display:flex; gap:10px; background:rgba(0,0,0,0.3); flex-shrink:0; }
    .input-area input { flex:1; padding:10px 14px; border-radius:12px; border:1px solid var(--stroke); background:rgba(12,22,22,0.7); color:var(--text); font-family:inherit; font-size:.9rem; outline:none; }
    .input-area input:focus { border-color:rgba(255,179,87,0.6); }
    .input-area button { padding:10px 18px; border-radius:999px; border:none; background:linear-gradient(120deg,var(--accent),#ffd18b); color:#1b1b1b; font-weight:600; cursor:pointer; font-size:.85rem; }
    .status-bar { padding:4px 20px; border-top:1px solid var(--stroke); font-size:.7rem; color:var(--muted); display:flex; gap:12px; flex-shrink:0; }
  </style>
</head>
<body>
  <header>
    <h1>${escHtml(profile.name)}</h1>
    <p>${escHtml(profile.specialization)}</p>
    <div class="badge">${archLabel}</div>
  </header>
  <div id="chatLog">
    <div class="bubble agent">Hello, I'm ${escHtml(profile.name)}. ${escHtml(profile.persona || "")}</div>
  </div>
  <div class="input-area">
    <input type="text" id="chatInput" placeholder="Ask ${escHtml(profile.name)} something..." autofocus />
    <button id="sendBtn">Send</button>
  </div>
  <div class="status-bar">
    <span>Mode: mock</span>
    <span>${archLabel}</span>
    <span style="flex:1;text-align:right;">Set LLM_API_BASE + LLM_API_KEY env for remote model</span>
  </div>
  <script>
    const chatLog = document.getElementById('chatLog');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');

    const profile = window.ai && window.ai.profile ? window.ai.profile : ${JSON.stringify(profile)};

    function addBubble(text, role) {
      const div = document.createElement('div');
      div.className = 'bubble ' + role;
      div.textContent = text;
      chatLog.appendChild(div);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function buildMockReply(msg) {
      return [profile.name + ' (specialized in ' + profile.specialization + ')', 'Tone: ' + (profile.tone || 'Direct, helpful, concise'), '', 'Request: ' + msg, '', 'Answer:', 'Mock response. Set LLM_API_BASE and LLM_API_KEY to connect a real model.'].join('\\n');
    }

    async function sendMessage() {
      const msg = chatInput.value.trim();
      if (!msg) return;
      chatInput.value = '';
      addBubble(msg, 'user');
      addBubble(buildMockReply(msg), 'agent');
    }

    chatInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') sendMessage();
    });
    sendBtn.addEventListener('click', sendMessage);
    chatInput.focus();
  </script>
</body>
</html>`;

  await fs.writeFile(path.join(dir, "package.json"), pkg + "\n", "utf8");
  await fs.writeFile(path.join(dir, "main.js"), mainJs + "\n", "utf8");
  await fs.writeFile(path.join(dir, "preload.js"), preloadJs + "\n", "utf8");
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.DS_Store\n", "utf8");
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeSlug(value) {
  const slug = String(value || "custom-ai")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "custom-ai";
}

if (require.main === module) {
  startServer(Number(PORT));
}

module.exports = app;
