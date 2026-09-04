<?php

declare(strict_types=1);

namespace OCA\WatchGroups\Controller;

use OCA\WatchGroups\Service\WatcherClient;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;

class DashboardController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private WatcherClient $watcherClient,
    ) {
        parent::__construct($appName, $request);
    }

    public function index(): TemplateResponse {
        $dashboard = $this->watcherClient->getDashboard();

        return new TemplateResponse('watchgroups', 'main', [
            'dashboard' => $dashboard,
            'state' => $dashboard['state'] ?? [],
            'summaries' => $dashboard['summaries'] ?? [],
            'watcherUrl' => getenv('WATCHER_API_URL') ?: '',
        ]);
    }

    public function apiState(): array {
        return $this->watcherClient->getState();
    }

    public function apiSummaries(): array {
        return $this->watcherClient->getSummaries();
    }
}
