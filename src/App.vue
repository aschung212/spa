<template>
  <img alt="Ducati logo" src="./assets/logo.png" />
  <HelloWorld msg="Hello Aaron!" />
  <CustomComponent msg="custom message"/>
</template>

<script>
import HelloWorld from './components/HelloWorld.vue'
import CustomComponent from './components/CustomComponent.vue'

export default {
  name: 'App',
  components: {
    HelloWorld,
    CustomComponent
  }
}
</script>
