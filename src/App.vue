<template>
  <img alt="Ducati logo" src="./assets/logo.png" />
  <HelloWorld msg="Hello Aaron!" />
  <BasicDiv msg="Here's a basic div for you to play with" />
  <CustomComponent msg="!noraA olleH"/>
</template>

<script>
import HelloWorld from './components/HelloWorld.vue'
import CustomComponent from './components/CustomComponent.vue'
import BasicDiv from './components/BasicDiv.vue';

export default {
  name: 'App',
  components: {
    HelloWorld,
    CustomComponent,
    BasicDiv
  }
}
</script>
