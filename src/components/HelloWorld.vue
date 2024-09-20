<template>
  <div :class="['countContainer', count%2 === 0 ? 'evenCount' : 'oddCount']">
    <h1>{{ msg }}</h1>
    <h2>count: {{ count }}</h2>
    <h1>{{ c }}</h1>
    <button @click="count++" class="counterButton">+1</button>
    <button @click="count = 0" type="button" class="resetButton">Reset</button>
  </div>
</template>

<script>
  export default {
    name: 'HelloWorld',
    props: {
      msg: String,
      c: Number
    },
    data() {
      return {
        count: 0
      }
    }
  }
</script>
