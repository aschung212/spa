<template>
    <div class="basicDiv">
        <h1>{{ msg }}</h1>
    <div class="basicDivButtonBox">
        <button @click="randomize" class="customButton">randomize</button>
        <button @click="decrement" class="customButton">-{{ c }}</button>
        <button @click="increment" class="customButton">+{{ c }}</button>
        <!-- <button @click="$emit('kaboomButton')" class="customButton">KABOOM!</button> -->
        <button @click="kaboom" class="customButton">KABOOM!</button>
    </div>
    </div>
</template>

<script setup>
import { useCounterStore } from '../stores/counter';
let storeCounter = useCounterStore();

let randomize = () => {
    storeCounter.randomize();
    emit('randomizeButton');
}

let increment = () => {
    storeCounter.increment(props.c);
    emit('incrementButton');
}

let decrement = () => {
    storeCounter.decrement(props.c);
    emit('decrementButton');
}

let kaboom = () => {
    storeCounter.reset();
    emit('kaboomButton')
}

const props = defineProps({
    msg: String,
    c: Number
});
const emit = defineEmits(['randomizeButton', 'incrementButton', 'decrementButton', 'kaboomButton'])
</script>
  