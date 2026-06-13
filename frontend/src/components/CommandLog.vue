<script setup lang="ts">
import type { LogEntry } from '../types/commands'

defineProps<{
  entries: LogEntry[]
}>()
</script>

<template>
  <section class="command-log">
    <h3>指令日志</h3>
    <div v-if="entries.length === 0" class="empty">暂无记录，输入指令开始绘图</div>
    <div v-for="entry in [...entries].reverse()" :key="entry.id" class="log-entry">
      <div class="meta">
        <span class="time">{{ entry.timestamp }}</span>
        <span v-if="entry.response?.mockMode" class="badge mock">Mock</span>
        <span v-else class="badge live">LLM</span>
      </div>
      <div class="text"><strong>输入：</strong>{{ entry.text }}</div>
      <div v-if="entry.error" class="error">{{ entry.error }}</div>
      <template v-else-if="entry.response">
        <div class="speak"><strong>回复：</strong>{{ entry.response.speak }}</div>
        <pre class="json">{{ JSON.stringify(entry.response.actions, null, 2) }}</pre>
        <ul v-if="entry.executed?.length" class="executed">
          <li v-for="(msg, i) in entry.executed" :key="i">{{ msg }}</li>
        </ul>
      </template>
    </div>
  </section>
</template>

<style scoped>
.command-log {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-height: 480px;
  overflow-y: auto;
}

h3 {
  margin: 0;
  font-size: 1rem;
  position: sticky;
  top: 0;
  background: #f8fafc;
  padding-bottom: 0.5rem;
}

.empty {
  color: #94a3b8;
  font-size: 0.9rem;
}

.log-entry {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.75rem;
  font-size: 0.85rem;
}

.meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.4rem;
}

.time {
  color: #94a3b8;
  font-size: 0.75rem;
}

.badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
}

.badge.mock {
  background: #fef3c7;
  color: #b45309;
}

.badge.live {
  background: #dcfce7;
  color: #15803d;
}

.text,
.speak {
  margin-bottom: 0.3rem;
}

.error {
  color: #dc2626;
}

.json {
  background: #f1f5f9;
  padding: 0.5rem;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 0.75rem;
  margin: 0.4rem 0;
}

.executed {
  margin: 0.3rem 0 0;
  padding-left: 1.2rem;
  color: #475569;
}
</style>
