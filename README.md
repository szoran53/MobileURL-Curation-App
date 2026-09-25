# linkcurator (MobileURL-Curation-App)

An Express PWA that curates links (title / summary / category / tags) using a
**local Ternary-Bonsai-2-27B** model served by **llama.cpp llama-server** over its
OpenAI-compatible API — instead of the Anthropic cloud API.

## LLM config (confirmed on 10.0.10.3)

| Setting | Value |
|---|---|
| llama.cpp API | `http://10.0.10.3:8088/v1` |
| model id (from `GET /v1/models`) | `/home/steve/Downloads/Bonsai-demo/Bonsai-demo/models/bonsai2-gguf/27B/Ternary-Bonsai-2-27B-PQ2_0.gguf` |
| context window | 262144 tokens |
| quantization | PQ2_0 — 2.13 bpw (ternary, very low precision) |
| auth | **none** (works with no API key) |
| inference | fast, ~5s per link |

## Local run (no Docker, on any machine that can reach llama.cpp)

```bash
cp .env.example .env                 # set LLM_BASE_URL to the llama.cpp host/port
npm install
node server.js                      # app on http://localhost:3000
```

## Docker deploy on 10.0.10.3

The container runs on the **same host as llama.cpp** (10.0.10.3).

### 1) Install Docker (once) on 10.0.10.3

```bash
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
sudo systemctl enable --now docker
docker --version
```
(Add your user to `docker` group if you don't want `sudo` every time:
`sudo usermod -aG docker $USER` then re-login.)

### 2) Get the app onto 10.0.10.3

```bash
git clone <your-repo-url> /home/steve/linkcurator   # or copy the branch
cd /home/steve/linkcurator
```

### 3) Configure & run

```bash
cp .env.example .env                    # defaults already point at 10.0.10.3 llama.cpp
docker compose build
docker compose up -d
docker compose logs -f linkcurator
```

### 4) Verify

```bash
# llama.cpp reachable from the container:
docker compose exec linkcurator curl -s http://127.0.0.1:8088/v1/models | head -c 200
# app's LLM diagnostics:
curl -s http://10.0.10.3:3000/api/test-llm
# curate a real link and poll until done:
ID=$(curl -s -X POST http://10.0.10.3:3000/api/links \
      -H 'Content-Type: application/json' \
      -d '{"url":"https://arxiv.org/abs/2312.03705"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
sleep 5; curl -s "http://10.0.10.3:3000/api/links/$ID/status"
```

### Data persistence

The SQLite DB lives on the host at `./data/links.db` (mounted as `/data` via
`DATA_DIR=/data`). It survives container rebuilds/restarts:

```bash
ls -la ./data/links.db
sqlite3 ./data/links.db "SELECT id,title,category,tags,status FROM links LIMIT 10;"
```

### Networking decision

- **Host networking (used here, recommended for same-host).** The container
  shares the host network and reaches llama.cpp over `127.0.0.1:8088` — no
  routing ambiguity. The app is reachable at `http://10.0.10.3:3000` directly.
  No port mapping is used with host networking.
- **Bridge (alternative, isolated).** `network_mode: bridge` +
  `ports: ["3000:3000"]` + `LLM_BASE_URL: http://10.0.10.3:8088/v1`. Only port
  3000 is published; the rest is isolated.

## Caveats

- **Model id must be the exact id from `GET /v1/models`** (the full gguf path)
  so the app's `/api/test-llm` model match succeeds.
- **Quantization is very low** (PQ2_0, 2.13 bpw ternary): expect coarse
  quality, though it's fast.
- **Inference is fast here** (~5s); the `LLM_TIMEOUT_MS` default (180s) is
  generous.
- **No auth:** this server accepts unauthenticated requests.

## Gate

`npm run check` (ESLint + node:test) is the local gate: 0 errors, 11 tests
passing.
