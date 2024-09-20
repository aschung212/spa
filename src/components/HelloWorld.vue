<template>
  <h1>{{ msg }}</h1>
  <h2>count is: {{ count }}</h2>
  <button @click="count++">+1</button>
  <button @click="count = 0" type="button">Reset</button>
</template>

<script>
export default {
  name: 'HelloWorld',
  props: {
    msg: String
  },
  data() {
    return {
      count: 0
    }
  }
}
</script>
