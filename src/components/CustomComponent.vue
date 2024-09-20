<template>
  <div :class="['countContainer', count%2 === 0 ? 'evenCount' : 'oddCount']">
    <h1>{{ msg }}</h1>
    <h2>count: {{ count }}</h2>
    <button @click="decreaseCount" class="counterButton">-1</button>
    <button @click="count = 0" type="button" class="resetButton">Reset</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

let count = ref(0);
let decreaseCount = () => {
  count.value--;
}
let props = defineProps({
  msg: String
})
</script>