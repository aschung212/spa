<template>
  <div :class="['countContainer', storeCounter.count % 2 === 0 ? 'evenCount' : 'oddCount']">
    <h1>{{ msg }}</h1>
    <h2>count: {{ storeCounter.count }}</h2>
    <button @click="increment" class="counterButton">{{ c }}</button>
    <button @click="storeCounter.reset" type="button" class="resetButton">Reset</button>
  </div>
</template>

<script setup>
import { useCounterStore } from '../stores/counter';

const storeCounter = useCounterStore();

let increment = () => {
  storeCounter.increment(1);
}

let decrement = () => {
  storeCounter.decrement(props.c);
}

const props = defineProps({
  msg: String,
  c: String
});
</script>
