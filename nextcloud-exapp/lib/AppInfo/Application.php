<?php

declare(strict_types=1);

namespace OCA\WatchGroups\AppInfo;

use OCP\AppFramework\App;
use OCP\Http\Client\IClientService;
use OCA\WatchGroups\Service\WatcherClient;

class Application extends App {
    public const APP_ID = 'watchgroups';

    public function __construct() {
        parent::__construct(self::APP_ID);

        $this->getContainer()->registerService(WatcherClient::class, function ($c) {
            $baseUrl = getenv('WATCHER_API_URL') ?: 'http://watcher:3000';
            return new WatcherClient(
                $c->query(IClientService::class),
                $baseUrl,
            );
        });
    }
}
