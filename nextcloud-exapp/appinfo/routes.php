<?php

return [
    'routes' => [
        [
            'name' => 'dashboard#index',
            'url' => '/',
            'verb' => 'GET',
        ],
        [
            'name' => 'dashboard#apiState',
            'url' => '/api/state',
            'verb' => 'GET',
        ],
        [
            'name' => 'dashboard#apiSummaries',
            'url' => '/api/summaries',
            'verb' => 'GET',
        ],
    ],
];
