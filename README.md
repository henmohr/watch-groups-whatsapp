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

## Publish summaries in Nextcloud Talk

The watcher can publish each generated summary to a Talk conversation using a Talk bot.
The bot must be installed on Nextcloud with a secret of at least 40 characters:

```bash
docker exec -u www-data nextcloud-docker-app-1 php occ talk:bot:install \
  "WhatsApp Watch Groups" \
  "REPLACE_WITH_A_LONG_RANDOM_SECRET" \
  "https://cloud.example.com/ocs/v2.php/apps/app_api/talk_proxy/watchgroups/talk-bot" \
  "Publishes summaries from monitored WhatsApp groups" \
  --feature response
```

Use `talk:bot:list` to get the bot ID, then add it to a Talk conversation:

```bash
docker exec -u www-data nextcloud-docker-app-1 php occ talk:bot:setup BOT_ID CONVERSATION_TOKEN
```

Configure the watcher `.env` with the same secret and conversation token:

```dotenv
NEXTCLOUD_TALK_PUBLISH=1
NEXTCLOUD_TALK_URL=https://cloud.example.com
NEXTCLOUD_TALK_BOT_SECRET=the_same_long_random_secret
NEXTCLOUD_TALK_CONVERSATION_TOKEN=conversation_token
```

For one Talk conversation per WhatsApp group, use `NEXTCLOUD_TALK_CONVERSATION_MAP` with comma-separated `group-id=conversation-token` entries instead.
