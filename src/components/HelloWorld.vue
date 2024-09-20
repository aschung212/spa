<template>
  <div :class="['countContainer', count%2 === 0 ? 'evenCount' : 'oddCount']">
    <h1>{{ msg }}</h1>
    <h2>count: {{ count }}</h2>
    <h1>{{ c }}</h1>
    <button @click="increaseCount" class="counterButton">+1</button>
    <button @click="count = 0" type="button" class="resetButton">Reset</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const count = ref(0);

const increaseCount = () => {
  count.value++;
}
const props = defineProps({
  msg: String,
  c: Number
});
</script>
