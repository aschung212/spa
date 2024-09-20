<template>
    <div class="basicDiv">
        <h1>{{ msg }}</h1>
    <div class="basicDivButtonBox">
        <button @click="console.log('button was clicked!')" class="customButton">CLICK</button>
        <button @click="console.log('button was clicked!')" class="customButton">MAYBE CLICK</button>
        <button @click="console.log('button was clicked!')" class="customButton">DON'T CLICK</button>
        <button @click="$emit('kaboomButton')" class="customButton">KABOOM!</button>
    </div>
    </div>
</template>

<script setup>
    const props = defineProps({
        msg: String
    });
    const emit = defineEmits(['kaboomButton'])
</script>
  