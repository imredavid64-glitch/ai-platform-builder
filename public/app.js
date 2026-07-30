const modeIndicator = document.getElementById("modeIndicator");
const embeddingIndicator = document.getElementById("embeddingIndicator");
const archIndicator = document.getElementById("archIndicator");
const buildIndicator = document.getElementById("buildIndicator");
const settingsBtn = document.getElementById("settingsBtn");
const exportBtn = document.getElementById("exportBtn");
const resetBtn = document.getElementById("resetBtn");
const settingsModal = document.getElementById("settingsModal");
const closeSettings = document.getElementById("closeSettings");
const providerSelect = document.getElementById("providerSelect");
const apiKeyInput = document.getElementById("apiKeyInput");
const modelInput = document.getElementById("modelInput");
const providerHint = document.getElementById("providerHint");
const testConnectionBtn = document.getElementById("testConnectionBtn");
const testResult = document.getElementById("testResult");
const saveSettings = document.getElementById("saveSettings");

const profileForm = document.getElementById("profileForm");
const nameInput = document.getElementById("name");
const personaInput = document.getElementById("persona");
const specializationInput = document.getElementById("specialization");
const toneInput = document.getElementById("tone");
const goalsInput = document.getElementById("goals");
const constraintsInput = document.getElementById("constraints");
const buildTypeInput = document.getElementById("buildType");
const architectureInput = document.getElementById("architecture");
const archInfo = document.getElementById("archInfo");
const generateBtn = document.getElementById("generateBtn");
const promptPreview = document.getElementById("promptPreview");
const resultPanel = document.getElementById("resultPanel");
const resultTitle = document.getElementById("resultTitle");
const resultContent = document.getElementById("resultContent");
const resultFiles = document.getElementById("resultFiles");
const resultPreview = document.getElementById("resultPreview");

const trainForm = document.getElementById("trainForm");
const noteTitle = document.getElementById("noteTitle");
const noteSource = document.getElementById("noteSource");
const noteContent = document.getElementById("noteContent");
const notesList = document.getElementById("notesList");

const ingestForm = document.getElementById("ingestForm");
const docTitle = document.getElementById("docTitle");
const docSource = document.getElementById("docSource");
const docFile = document.getElementById("docFile");
const docContent = document.getElementById("docContent");
const docsList = document.getElementById("docsList");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatLog = document.getElementById("chatLog");

const galleryGrid = document.getElementById("galleryGrid");
const editIndicator = document.getElementById("editIndicator");
const editName = document.getElementById("editName");
const cancelEdit = document.getElementById("cancelEdit");

let editingSlug = null;

init();

async function init() {
  await Promise.all([loadHealth(), loadProfile(), loadNotes(), loadDocs(), loadProfiles(), loadConfig()]);
}

// ---- Settings Modal ----

settingsBtn.addEventListener("click", () => {
  settingsModal.classList.remove("hidden");
});

closeSettings.addEventListener("click", () => {
  settingsModal.classList.add("hidden");
});

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
});

providerSelect.addEventListener("change", () => {
  const hints = {
    mock: "No API key needed. Chat uses mock replies.",
    groq: "Get a free API key at console.groq.com",
    openrouter: "Get an API key at openrouter.ai/keys",
    google: "Get a Gemini API key at aistudio.google.com"
  };
  providerHint.textContent = hints[providerSelect.value] || "";
  if (providerSelect.value === "mock") {
    apiKeyInput.disabled = true;
    apiKeyInput.placeholder = "No API key needed";
  } else {
    apiKeyInput.disabled = false;
    apiKeyInput.placeholder = "Enter your API key";
  }
});

testConnectionBtn.addEventListener("click", async () => {
  testResult.textContent = "Testing...";
  testResult.className = "test-result";
  try {
    const res = await fetch("/api/chat/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerSelect.value,
        apiKey: apiKeyInput.value,
        model: modelInput.value
      })
    });
    const data = await res.json();
    if (data.ok) {
      testResult.textContent = "Connection successful!";
      testResult.className = "test-result success";
    } else {
      testResult.textContent = "Error: " + (data.error || "Unknown");
      testResult.className = "test-result error";
    }
  } catch (err) {
    testResult.textContent = "Error: " + err.message;
    testResult.className = "test-result error";
  }
});

saveSettings.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerSelect.value,
        apiKey: apiKeyInput.value,
        model: modelInput.value
      })
    });
    const data = await res.json();
    if (data.ok) {
      settingsModal.classList.add("hidden");
      await loadHealth();
      showMeta("Provider set to " + data.provider);
    }
  } catch (err) {
    showMeta("Config error: " + err.message);
  }
});

async function loadConfig() {
  const res = await fetch("/api/config");
  const cfg = await res.json();
  if (cfg.provider) providerSelect.value = cfg.provider;
  if (cfg.model) modelInput.value = cfg.model;
  apiKeyInput.value = cfg.hasKey ? "********" : "";
  apiKeyInput.disabled = cfg.provider === "mock";
  providerSelect.dispatchEvent(new Event("change"));
}

cancelEdit.addEventListener("click", (e) => {
  e.preventDefault();
  editingSlug = null;
  editIndicator.classList.add("hidden");
  nameInput.value = "";
  personaInput.value = "";
  specializationInput.value = "";
  toneInput.value = "Direct, helpful, concise";
  goalsInput.value = "";
  constraintsInput.value = "";
  buildTypeInput.value = "agent";
  architectureInput.value = "single";
  updateArchDisplay();
  updateButtonLabel();
  promptPreview.textContent = "Define the AI to generate a live prompt.";
  resultPanel.classList.add("hidden");
});

async function loadProfiles() {
  const res = await fetch("/api/profiles");
  const profiles = await res.json();
  renderGallery(profiles);
}

function renderGallery(profiles) {
  if (!galleryGrid) return;
  if (!profiles.length) {
    galleryGrid.innerHTML = '<p class="hint" style="text-align:center;grid-column:1/-1">No profiles yet. Create one below.</p>';
    return;
  }
  let html = "";
  for (const p of profiles) {
    const buildLabel = { agent: "Agent", website: "Website", desktop: "Desktop App" }[p.buildType] || "Agent";
    const archLabel = { single: "Single", "multi-llm": "Multi-LLM", sustainable: "Sustainable" }[p.architecture] || "Single";
    html += '<div class="gallery-card">';
    html += '<div class="gallery-name">' + escHtml(p.name) + '</div>';
    html += '<div class="gallery-spec">' + escHtml(p.specialization) + '</div>';
    html += '<div class="gallery-meta"><span>' + buildLabel + '</span><span>' + archLabel + '</span></div>';
    html += '<div class="gallery-actions">';
    html += '<button class="ghost gallery-edit" data-slug="' + escHtml(p.slug) + '">Edit</button>';
    html += '<button class="ghost gallery-duplicate" data-slug="' + escHtml(p.slug) + '">Duplicate</button>';
    html += '<button class="ghost gallery-delete" data-slug="' + escHtml(p.slug) + '" style="color:var(--danger)">Delete</button>';
    html += '</div></div>';
  }
  galleryGrid.innerHTML = html;

  galleryGrid.querySelectorAll(".gallery-edit").forEach(btn => {
    btn.addEventListener("click", () => loadProfileForEdit(btn.dataset.slug));
  });
  galleryGrid.querySelectorAll(".gallery-duplicate").forEach(btn => {
    btn.addEventListener("click", () => duplicateProfile(btn.dataset.slug));
  });
  galleryGrid.querySelectorAll(".gallery-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteProfile(btn.dataset.slug));
  });
}

async function loadProfileForEdit(slug) {
  const res = await fetch("/api/profile/" + slug);
  if (!res.ok) return;
  const profile = await res.json();
  setProfileFields(profile);
  editingSlug = slug;
  editName.textContent = profile.name;
  editIndicator.classList.remove("hidden");
  promptPreview.textContent = profile.systemPrompt || "Define the AI to generate a live prompt.";
  document.getElementById("builder").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function duplicateProfile(slug) {
  const res = await fetch("/api/profile/" + slug + "/duplicate", { method: "POST" });
  if (!res.ok) return;
  await loadProfiles();
}

async function deleteProfile(slug) {
  if (!confirm("Delete this profile and its generated files?")) return;
  const res = await fetch("/api/profile/" + slug, { method: "DELETE" });
  if (!res.ok) return;
  if (editingSlug === slug) {
    editingSlug = null;
    editIndicator.classList.add("hidden");
  }
  await Promise.all([loadProfiles(), loadProfile()]);
}

async function loadHealth() {
  const res = await fetch("/api/health");
  const data = await res.json();
  modeIndicator.textContent = `Mode: ${data.mode} (${data.model})`;
  embeddingIndicator.textContent = `Embeddings: ${data.embeddingMode} (${data.embeddingModel})`;
}

async function loadProfile() {
  const res = await fetch("/api/profile");
  const profile = await res.json();
  setProfileFields(profile);
  promptPreview.textContent = profile.systemPrompt || "Define the AI to generate a live prompt.";
}

function setProfileFields(profile) {
  nameInput.value = profile.name || "";
  personaInput.value = profile.persona || "";
  specializationInput.value = profile.specialization || "";
  toneInput.value = profile.tone || toneInput.value;
  goalsInput.value = profile.goals || "";
  constraintsInput.value = profile.constraints || "";
  buildTypeInput.value = profile.buildType || "agent";
  architectureInput.value = profile.architecture || "single";
  updateArchDisplay();
  updateButtonLabel();
}

function updateArchDisplay() {
  const arch = architectureInput.value;
  const labels = {
    single: { label: "Single LLM", desc: "one model handles all requests" },
    "multi-llm": { label: "Multi-LLM Routing", desc: "routes queries to specialized models by task type (analytical, creative, simple)" },
    sustainable: { label: "Sustainable (Efficient)", desc: "response caching, local embeddings, minimal compute overhead" }
  };
  const info = labels[arch] || labels.single;
  archInfo.innerHTML = '<span class="arch-label">' + info.label + '</span> &mdash; ' + info.desc;
  archIndicator.textContent = "Architecture: " + info.label;
}

function updateButtonLabel() {
  const type = buildTypeInput.value;
  const labels = { website: "Generate Website", desktop: "Generate Desktop App", agent: "Generate Platform" };
  const buildLabels = { website: "Website", desktop: "Desktop App", agent: "AI Agent" };
  generateBtn.textContent = labels[type] || labels.agent;
  buildIndicator.textContent = "Build: " + (buildLabels[type] || buildLabels.agent);
}

buildTypeInput.addEventListener("change", function() {
  updateButtonLabel();
  resultPanel.classList.add("hidden");
});
architectureInput.addEventListener("change", function() {
  updateArchDisplay();
  resultPanel.classList.add("hidden");
});

function showResult(profile) {
  const gen = profile.generated;
  if (!gen || !gen.instructions) return;

  const inst = gen.instructions;
  resultTitle.textContent = inst.title;

  // Steps
  let html = '<ol>';
  for (const step of inst.steps) {
    html += '<li>' + escHtml(step) + '</li>';
  }
  html += '</ol>';
  resultContent.innerHTML = html;

  // Files
  if (inst.files && inst.files.length) {
    let filesHtml = '';
    for (const f of inst.files) {
      filesHtml += '<code>' + escHtml(f) + '</code>';
    }
    resultFiles.innerHTML = filesHtml;
  } else {
    resultFiles.innerHTML = '';
  }

  // Preview link for websites
  if (gen.previewUrl) {
    resultPreview.innerHTML = '<a href="' + gen.previewUrl + '" target="_blank" class="btn-preview">Open Preview &rarr;</a>';
  } else if (gen.slug) {
    resultPreview.innerHTML = '<span style="color:var(--muted);font-size:0.85rem;">Generated in <code style="background:rgba(0,0,0,0.3);padding:2px 8px;border-radius:4px;">generated/' + escHtml(gen.slug) + '/</code></span>';
  } else {
    resultPreview.innerHTML = '';
  }

  resultPanel.classList.remove("hidden");
  resultPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadNotes() {
  const res = await fetch("/api/notes");
  const notes = await res.json();
  renderNotes(notes);
}

async function loadDocs() {
  const res = await fetch("/api/chunks");
  const data = await res.json();
  renderDocs(data.docs || []);
}

function renderNotes(notes) {
  notesList.innerHTML = "";
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.textContent = "No training notes yet.";
    empty.className = "hint";
    notesList.appendChild(empty);
    return;
  }

  for (const note of notes) {
    const card = document.createElement("div");
    card.className = "note";

    const title = document.createElement("h4");
    title.textContent = note.title;

    const content = document.createElement("p");
    content.textContent = note.content;

    card.appendChild(title);
    card.appendChild(content);
    notesList.appendChild(card);
  }
}

function renderDocs(docs) {
  docsList.innerHTML = "";
  const filtered = docs.filter((doc) => doc.type === "document");
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.textContent = "No indexed documents yet.";
    empty.className = "hint";
    docsList.appendChild(empty);
    return;
  }

  for (const doc of filtered) {
    const card = document.createElement("div");
    card.className = "note";

    const title = document.createElement("h4");
    title.textContent = doc.title;

    const meta = document.createElement("p");
    meta.textContent = `${doc.chunkCount} chunk(s) · ${doc.source || "No source"}`;

    card.appendChild(title);
    card.appendChild(meta);
    docsList.appendChild(card);
  }
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";
  const payload = {
    name: nameInput.value,
    persona: personaInput.value,
    specialization: specializationInput.value,
    tone: toneInput.value,
    goals: goalsInput.value,
    constraints: constraintsInput.value,
    buildType: buildTypeInput.value,
    architecture: architectureInput.value
  };
  if (editingSlug) {
    payload.slug = editingSlug;
  }

  try {
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      showMeta(`Profile error: ${err.error || "unknown"}`);
      return;
    }

    const profile = await res.json();
    promptPreview.textContent = profile.systemPrompt;
    showResult(profile);
    editingSlug = null;
    editIndicator.classList.add("hidden");
    await loadProfiles();
  } finally {
    generateBtn.disabled = false;
    updateButtonLabel();
  }
});

trainForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    title: noteTitle.value,
    source: noteSource.value,
    content: noteContent.value
  };

  const res = await fetch("/api/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json();
    showMeta(`Training error: ${err.error || "unknown"}`);
    return;
  }

  noteTitle.value = "";
  noteSource.value = "";
  noteContent.value = "";
  await Promise.all([loadNotes(), loadDocs()]);
  showMeta("Training note added.");
});

ingestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    title: docTitle.value,
    source: docSource.value,
    content: docContent.value
  };

  const res = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json();
    showMeta(`Ingest error: ${err.error || "unknown"}`);
    return;
  }

  docTitle.value = "";
  docSource.value = "";
  docContent.value = "";
  docFile.value = "";
  await loadDocs();
  showMeta("Document indexed.");
});

docFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  const text = await file.text();
  if (!docTitle.value) {
    docTitle.value = file.name;
  }
  docContent.value = text;
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) {
    return;
  }

  chatInput.value = "";
  addBubble("user", message);

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });

  const data = await res.json();
  addBubble("agent", data.reply);

  if (data.usedSources && data.usedSources.length) {
    const list = data.usedSources
      .map((item) => `${item.title} (${item.type})`)
      .join(" | ");
    addBubble("meta", `Used context: ${list}`);
  }
});

exportBtn.addEventListener("click", async () => {
  const res = await fetch("/api/export");
  if (!res.ok) {
    showMeta("Export failed.");
    return;
  }
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const match = /filename=\"?([^\";]+)\"?/i.exec(disposition);
  const filename = match ? match[1] : "ai-platform.zip";

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showMeta(`Exported ${filename}`);
});

resetBtn.addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  await Promise.all([loadProfile(), loadNotes(), loadDocs(), loadHealth()]);
  chatLog.innerHTML = "";
  showMeta("Reset complete.");
});

function addBubble(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role === "user" ? "user" : role === "meta" ? "meta" : "agent"}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showMeta(message) {
  addBubble("meta", message);
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
