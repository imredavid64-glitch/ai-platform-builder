# AI Platform Builder

A small app that turns a written brief into a working AI profile, stores training notes, indexes documents with embeddings, and generates a runnable platform folder.

## What "self-coding" means here
- When you generate a profile, the server writes a ready-to-use folder in `generated/<your-ai>`.
- That folder includes a `SYSTEM_PROMPT.md`, `profile.json`, and `agent.js` module that mirrors your definition.
- Training notes and indexed document chunks are persisted as JSON and used in responses.

## Run it
1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm run dev
```

3. Open the app at `http://localhost:3000`.

## Remote model + embeddings (optional)
By default the server replies in mock mode and uses local hash embeddings. To use a remote Chat Completions API and embeddings endpoint, set:

- `LLM_API_BASE` (base URL, no trailing slash)
- `LLM_API_KEY`
- `LLM_MODEL` (optional)
- `LLM_TEMPERATURE` (optional)
- `LLM_MODE=remote` (optional, auto-detected if base+key exist)

Embeddings:

- `LLM_EMBEDDINGS_MODEL` (optional)
- `LLM_EMBEDDINGS_MODE=remote` (optional, auto-detected if base+key exist)

If a remote call fails, the server falls back to mock replies or local embeddings.

## Export
Use the "Export ZIP" button in the UI to download the generated platform folder.
