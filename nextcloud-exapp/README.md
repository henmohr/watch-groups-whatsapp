# Nextcloud ExApp Skeleton

This folder is the starting point for a Nextcloud 35 ExApp that fronts the WhatsApp watcher.

Suggested split:

- `watcher` service: Baileys connection, message ingestion, summarization
- `nextcloud-exapp` service: Nextcloud UI, navigation, user-facing API

The ExApp should proxy or read data from the watcher and present it inside Nextcloud.

Minimal next steps:

1. add an ExApp container image
2. implement the ExApp lifecycle endpoints
3. register the app in AppAPI
4. connect the UI to the watcher API

Development:

```bash
docker compose -f nextcloud-exapp/docker-compose.yml up --build
```

The `exapp-build` service is only a syntax/build check for the PHP app code.

Registration helpers:

```bash
make -C nextcloud-exapp daemon-register NEXTCLOUD_URL=https://nextcloud.example
make -C nextcloud-exapp app-register-manual
make -C nextcloud-exapp app-enable
```
