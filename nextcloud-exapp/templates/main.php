<?php

/** @var array $_ */

$state = $_['state'] ?? [];
$summaries = $_['summaries'] ?? [];
$dashboard = $_['dashboard'] ?? [];
$watcherUrl = $_['watcherUrl'] ?? '';
$groups = $state['groups'] ?? [];
$connectionStatus = $state['connectionStatus'] ?? 'unknown';
$watchedCount = $state['watchedCount'] ?? count($groups);
$watcherReachable = $dashboard['reachable'] ?? false;
$watcherError = $dashboard['error'] ?? '';
?>
<div class="watchgroups-app">
  <h1>Watch Groups WhatsApp</h1>
  <p class="watchgroups-meta">
    <span>Status: <strong><?php p($connectionStatus); ?></strong></span>
    <span>Watcher: <strong><?php p($watcherReachable ? 'online' : 'offline'); ?></strong></span>
    <span>Grupos acompanhados: <strong><?php p((string)$watchedCount); ?></strong></span>
    <?php if ($watcherUrl !== ''): ?>
      <span>Watcher: <strong><?php p($watcherUrl); ?></strong></span>
    <?php endif; ?>
  </p>

  <?php if (!$watcherReachable): ?>
    <div class="watchgroups-empty watchgroups-error">
      Não foi possível acessar o watcher. Verifique `WATCHER_API_URL`, a rede do container e se o serviço do watcher está ativo.
      <?php if ($watcherError !== ''): ?>
        <div class="watchgroups-error-detail"><?php p($watcherError); ?></div>
      <?php endif; ?>
    </div>
  <?php elseif (empty($groups)): ?>
    <div class="watchgroups-empty">
      Nenhum grupo carregado ainda. Verifique a conexão com o watcher.
    </div>
  <?php else: ?>
    <div class="watchgroups-grid">
      <?php foreach ($groups as $group): ?>
        <section class="watchgroups-card">
          <h2><?php p($group['subject'] ?? $group['id'] ?? 'Grupo'); ?></h2>
          <p class="watchgroups-subtitle"><?php p($group['id'] ?? ''); ?></p>

          <h3>Último resumo</h3>
          <?php if (!empty($group['latestSummary']['preview'])): ?>
            <div class="watchgroups-summary"><?php p($group['latestSummary']['preview']); ?></div>
          <?php else: ?>
            <div class="watchgroups-summary watchgroups-muted">Sem resumo ainda.</div>
          <?php endif; ?>

          <h3>Mensagens recentes</h3>
          <ul class="watchgroups-messages">
            <?php foreach (array_reverse($group['recentMessages'] ?? []) as $message): ?>
              <li>
                <strong><?php p($message['senderName'] ?? $message['sender'] ?? 'unknown'); ?></strong>
                <span><?php p($message['text'] ?? '[sem texto]'); ?></span>
                <small><?php p($message['ts'] ?? ''); ?></small>
              </li>
            <?php endforeach; ?>
          </ul>
        </section>
      <?php endforeach; ?>
    </div>
  <?php endif; ?>

  <?php if (!empty($summaries)): ?>
    <h2>Resumos consolidados</h2>
    <div class="watchgroups-grid">
      <?php foreach ($summaries as $summary): ?>
        <section class="watchgroups-card">
          <h3><?php p($summary['subject'] ?? $summary['groupId'] ?? 'Resumo'); ?></h3>
          <p class="watchgroups-subtitle">
            <?php p($summary['summary']['generatedAt'] ?? $summary['generatedAt'] ?? ''); ?>
          </p>
          <div class="watchgroups-summary"><?php p($summary['summary']['preview'] ?? $summary['summary'] ?? ''); ?></div>
        </section>
      <?php endforeach; ?>
    </div>
  <?php endif; ?>
</div>
