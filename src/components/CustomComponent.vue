<template>
  <h1>{{ msg }}</h1>
  <button @click="count--">count is: {{ count }}</button>
  <p>This is my custom component</p>
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
