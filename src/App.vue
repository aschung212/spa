<template>
  <Header />
  <HelloWorld msg="Hello Aaron!" :c='999'/>
  <BasicDiv msg="Here's a basic div for you to play with" @kaboom-button="console.log('emissions passed 💣')"/>
  <CustomComponent msg="!noraA olleH"/>
</template>

<script>
import HelloWorld from './components/HelloWorld.vue'
import CustomComponent from './components/CustomComponent.vue'
import BasicDiv from './components/BasicDiv.vue';
import Header from './components/Header.vue';

export default {
  name: 'App',
  components: {
    HelloWorld,
    CustomComponent,
    BasicDiv,
    Header
  }
}
</script>
