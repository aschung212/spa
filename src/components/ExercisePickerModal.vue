<template>
  <Teleport to="body">
    <div v-if="open" class="repMaxOverlay" @click.self="emit('close')" @keydown.escape="emit('close')">
      <div class="repMaxModal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <h2 :id="titleId">Choose Exercise</h2>
        <div class="wtExPickerList">
          <button
            v-for="ex in exercises"
            :key="ex.id"
            class="wtExPickerRow"
            @click="emit('select', ex.id)"
          >
            <span class="wtExPickerName">{{ ex.name }}</span>
            <span class="wtChevron">›</span>
          </button>
          <button
            class="wtExPickerRow wtExPickerNew"
            @click="emit('create-new')"
          >
            <span class="wtExPickerName">+ New exercise</span>
            <span class="wtChevron">›</span>
          </button>
        </div>
        <div class="repMaxActions">
          <button class="repMaxBtn repMaxBtnClose" @click="emit('close')">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { Exercise } from '../stores/workout'

withDefaults(defineProps<{
  open: boolean
  /** Active (non-archived) exercises offered for quick-logging. */
  exercises: Exercise[]
  /**
   * Id of the `<h2>` this dialog is labelled by. Per-host rather than a shared
   * constant because both hosts live under `<KeepAlive>` and each finds its own
   * dialog with a `useModal` selector — one id across two mounted hosts is a
   * duplicate id waiting to trap focus in the wrong tab's picker.
   */
  titleId?: string
}>(), {
  titleId: 'timeline-picker-title',
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', exerciseId: string): void
  (e: 'create-new'): void
}>()
</script>
