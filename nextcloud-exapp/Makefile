APP_ID=watchgroups
DAEMON_NAME=docker_local_sock
NEXTCLOUD_URL?=https://nextcloud.local
NEXTCLOUD_NETWORK?=internal
WATCHER_API_URL?=http://watcher:3000

.PHONY: daemon-register daemon-list app-register-manual app-register-docker app-enable app-disable app-unregister

daemon-register:
	php occ app_api:daemon:register $(DAEMON_NAME) "Local Docker" docker-install http /var/run/docker.sock "$(NEXTCLOUD_URL)" --net $(NEXTCLOUD_NETWORK)

daemon-list:
	php occ app_api:daemon:list

app-register-manual:
	php occ app_api:app:register $(APP_ID) manual_install --info-xml appinfo/info.xml

app-register-docker:
	php occ app_api:app:register $(APP_ID) $(DAEMON_NAME) --info-xml appinfo/info.xml

app-enable:
	php occ app_api:app:enable $(APP_ID)

app-disable:
	php occ app_api:app:disable $(APP_ID)

app-unregister:
	php occ app_api:app:unregister $(APP_ID)
