# Watch Groups WhatsApp

Minimal Baileys watcher that:

- logs group messages to `data/conversas.jsonl`
- keeps WhatsApp auth in `data/auth`
- writes summaries to `data/conhecimento.md`
- uses Groq by default for summarization

## Run

```bash
cp .env.example .env
docker compose up --build
```

If you want to watch only specific groups, set `GROUP_IDS` or `GROUP_NAMES` in `.env`.

To connect the watcher to the same Docker network as Nextcloud, set:

```bash
NEXTCLOUD_NETWORK=internal
```

Examples:

```bash
GROUP_IDS=120363419928713243@g.us,120363012345678901@g.us
GROUP_NAMES=financeiro,feira
```

The dashboard is available at `http://localhost:3000`.
