<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  submit: [text: string]
}>()

defineProps<{
  loading?: boolean
}>()

const text = ref('')

const examples = [
  '画一个红色的圆',
  '画一个蓝色的矩形',
  '把上一个改成绿色',
  '删除最后一个',
  '清空画布',
]

function submit(): void {
  const value = text.value.trim()
  if (!value) return
  emit('submit', value)
  text.value = ''
}

function useExample(example: string): void {
  text.value = example
}
</script>

<template>
  <section class="text-input">
    <h3>文本指令</h3>
    <form @submit.prevent="submit">
      <input
        v-model="text"
        type="text"
        placeholder="输入绘图指令，如：画一个红色的圆"
        :disabled="loading"
      />
      <button type="submit" :disabled="loading || !text.trim()">
        {{ loading ? '解析中...' : '执行' }}
      </button>
    </form>
    <div class="examples">
      <span>示例：</span>
      <button
        v-for="ex in examples"
        :key="ex"
        type="button"
        class="example-btn"
        :disabled="loading"
        @click="useExample(ex)"
      >
        {{ ex }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.text-input {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

h3 {
  margin: 0;
  font-size: 1rem;
}

form {
  display: flex;
  gap: 0.5rem;
}

input {
  flex: 1;
  padding: 0.6rem 0.75rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.95rem;
}

button[type='submit'] {
  padding: 0.6rem 1.2rem;
  background: #4f46e5;
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 600;
}

button[type='submit']:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  font-size: 0.85rem;
  color: #64748b;
}

.example-btn {
  padding: 0.25rem 0.6rem;
  border: 1px solid #e2e8f0;
  border-radius: 999px;
  background: white;
  font-size: 0.8rem;
  color: #475569;
}

.example-btn:hover:not(:disabled) {
  border-color: #a5b4fc;
  color: #4f46e5;
}
</style>
