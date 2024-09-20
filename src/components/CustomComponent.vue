<template>
  <div :class="['countContainer', storeCounter.count % 2 === 0 ? 'evenCount' : 'oddCount']">
    <h1>{{ msg }}</h1>
    <h2>count: {{ storeCounter.count }}</h2>
    <button @click="storeCounter.decrement" class="counterButton">-1</button>
    <button @click="storeCounter.reset" type="button" class="resetButton">Reset</button>
  </div>
</template>

<script setup>
import { useCounterStore } from '../stores/counter';

let storeCounter = useCounterStore();

let props = defineProps({
  msg: String
})
</script>