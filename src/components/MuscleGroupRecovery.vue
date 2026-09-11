<template>
  <div v-if="recovery.length > 0 || hiddenCount > 0" class="mgChart">
    <h2 class="mgTitle">Recovery</h2>
    <div class="recList" role="list" aria-label="Tag recovery status">
      <div
        v-for="item in recovery"
        :key="item.tag"
        class="recItem"
        role="listitem"
      >
        <button
          class="recRow"
          :aria-expanded="expandedTag === item.tag"
          :aria-label="`${item.tag}: ${formatDaysAgo(item.daysSince)}${item.status !== 'unknown' ? ', ' + item.status : ''}`"
          @click="expandedTag = expandedTag === item.tag ? null : item.tag"
        >
          <span v-if="item.recoveryDays !== null" class="recDot" :class="'recDot--' + item.status"></span>
          <span class="recName">{{ item.tag }}</span>
          <span class="recDays">{{ formatDaysAgo(item.daysSince) }}</span>
        </button>
        <div v-if="expandedTag === item.tag" class="recExpanded">
          <div class="recSettingRow">
            <span class="recSettingLabel">Recovery window</span>
            <div class="recSettingValue">
              <input
                type="number"
                inputmode="numeric"
                min="1"
                max="99"
                :value="item.recoveryDays ?? ''"
                placeholder="—"
                class="recDaysInput"
                aria-label="Recovery window in days"
                @change="onDaysChange(item.tag, $event)"
              />
              <span class="recDaysUnit">days</span>
            </div>
          </div>
          <button class="recActionBtn" @click="onHide(item.tag)">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            Hide from recovery
          </button>
        </div>
      </div>
    </div>

    <!-- Hidden tags footer -->
    <button
      v-if="hiddenCount > 0"
      class="recHiddenFooter"
      :aria-expanded="showHidden"
      @click="showHidden = !showHidden"
    >
      {{ hiddenCount }} hidden tag{{ hiddenCount === 1 ? '' : 's' }}
      <svg :class="{ recChevronOpen: showHidden }" class="recChevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>

    <div v-if="showHidden" class="recHiddenList">
      <div
        v-for="tag in hiddenTags"
        :key="tag"
        class="recHiddenItem"
      >
        <span class="recHiddenName">{{ tag }}</span>
        <button class="recActionBtn recShowBtn" @click="onShow(tag)">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Show
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { TagRecovery } from '../composables/useTagRecovery'

defineProps<{
  recovery: TagRecovery[]
  hiddenCount: number
  hiddenTags: string[]
}>()

const emit = defineEmits<{
  hide: [tag: string]
  show: [tag: string]
  'days-change': [tag: string, days: number | null]
}>()

const expandedTag = ref<string | null>(null)
const showHidden = ref(false)

function formatDaysAgo(days: number): string {
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

function onDaysChange(tag: string, event: Event) {
  const input = event.target as HTMLInputElement
  const val = input.value.trim()
  const parsed = parseInt(val, 10)
  emit('days-change', tag, val && !Number.isNaN(parsed) ? parsed : null)
}

function onHide(tag: string) {
  emit('hide', tag)
  expandedTag.value = null
}

function onShow(tag: string) {
  emit('show', tag)
}
</script>

<style scoped>
.mgChart {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 12px;
  border: 1px solid var(--border);
}

.mgTitle {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.recList {
  display: flex;
  flex-direction: column;
}

.recItem {
  border-bottom: 1px solid var(--border);
}

.recItem:last-child {
  border-bottom: none;
}

.recRow {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  color: inherit;
  font: inherit;
}

.recRow:active {
  opacity: 0.6;
}

.recDot {
  width: 8px;
  height: 8px;
  border-radius: 4px;
  flex-shrink: 0;
  margin-right: 8px;
}

.recDot--recovered {
  background-color: var(--success);
}

.recDot--recovering {
  background-color: var(--accent);
}

.recDot--recent {
  background-color: var(--text-muted);
}

.recName {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
  text-align: left;
}

.recDays {
  font-size: 13px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.recExpanded {
  padding: 4px 0 12px;
}

.recSettingRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  min-height: 44px;
}

.recSettingLabel {
  font-size: 13px;
  color: var(--text-secondary);
}

.recSettingValue {
  display: flex;
  align-items: center;
  gap: 8px;
}

.recDaysInput {
  width: 48px;
  min-height: 36px;
  padding: 8px;
  /* Token, not a raw px: the scale is rem-anchored so text honors Dynamic
     Type, and callout is the 16px iOS focus-zoom floor (LIFT-1376). */
  font-size: var(--font-callout);
  text-align: center;
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  -webkit-appearance: none;
  -moz-appearance: textfield;
}

.recDaysInput::placeholder {
  color: var(--text-muted);
}

.recDaysUnit {
  font-size: 13px;
  color: var(--text-muted);
}

.recActionBtn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  min-height: 44px;
  background: none;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  font-size: 13px;
  color: var(--text-secondary);
}

.recActionBtn:active {
  opacity: 0.6;
}

.recActionBtn svg {
  flex-shrink: 0;
}

.recHiddenFooter {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 12px 0 4px;
  background: none;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  font-size: 12px;
  color: var(--text-muted);
  min-height: 44px;
}

.recHiddenFooter:active {
  opacity: 0.6;
}

.recChevron {
  transition: transform 0.2s;
}

.recChevronOpen {
  transform: rotate(180deg);
}

.recHiddenList {
  padding: 4px 0;
}

.recHiddenItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
}

.recHiddenName {
  font-size: 14px;
  color: var(--text-muted);
}

.recShowBtn {
  color: var(--accent);
}
</style>
