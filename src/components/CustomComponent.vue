<template>
  <h1>{{ msg }}</h1>
  <h2>count is: {{ count }}</h2>
  <button @click="count--">-1</button>
  <button @click="count=0">reset</button>
</template>

<script>
export default {
  name: 'CustomComponent',
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
