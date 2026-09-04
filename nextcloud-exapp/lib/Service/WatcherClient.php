<?php

declare(strict_types=1);

namespace OCA\WatchGroups\Service;

use OCP\Http\Client\IClientService;

class WatcherClient {
    public function __construct(
        private IClientService $clientService,
        private string $baseUrl,
    ) {
    }

    public function getDashboard(): array {
        $baseUrl = rtrim($this->baseUrl, '/');
        if ($baseUrl === '') {
            return [
                'reachable' => false,
                'state' => [],
                'summaries' => [],
                'error' => 'WATCHER_API_URL nao configurado',
            ];
        }

        try {
            $state = $this->requestJsonOrThrow('/api/state');
            $summaries = $this->requestJsonOrThrow('/api/summaries');
        } catch (\Throwable $throwable) {
            return [
                'reachable' => false,
                'state' => [],
                'summaries' => [],
                'error' => $throwable->getMessage(),
            ];
        }

        return [
            'reachable' => true,
            'state' => $state,
            'summaries' => $summaries,
            'error' => null,
        ];
    }

    public function getState(): array {
        try {
            return $this->requestJsonOrThrow('/api/state');
        } catch (\Throwable $throwable) {
            return [];
        }
    }

    public function getSummaries(): array {
        try {
            return $this->requestJsonOrThrow('/api/summaries');
        } catch (\Throwable $throwable) {
            return [];
        }
    }

    private function requestJsonOrThrow(string $path): array {
        $baseUrl = rtrim($this->baseUrl, '/');
        if ($baseUrl === '') {
            throw new \RuntimeException('WATCHER_API_URL nao configurado');
        }

        $client = $this->clientService->newClient();
        $response = $client->get($baseUrl . $path, [
            'timeout' => 5,
        ]);

        if ($response->getStatusCode() < 200 || $response->getStatusCode() >= 300) {
            throw new \RuntimeException('Watcher returned HTTP ' . $response->getStatusCode());
        }

        $decoded = json_decode($response->getBody(), true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('Watcher response is not valid JSON');
        }

        return $decoded;
    }
}
