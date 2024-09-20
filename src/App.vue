<template>
  <Header />
  <HelloWorld 
    msg="Hello Aaron!" 
    :c="1"/>
  <BasicDiv 
    msg="Here's a basic div for you to play with" 
    :c="17" 
    @kaboom-button="console.log('emissions passed. Detonating in 3... 2.. 1 💣')"
    @randomize-button="console.log('shuffling...♠️♥️♣️♦️')"
    @increment-button="console.log('up, up, and away🚀')"
    @decrement-button="console.log('down bad📉')"
    />
  <HelloWorld 
    msg="!noraA olleH"
    :c="-1"/>
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
