import { defineStore } from "pinia";

export const useCounterStore = defineStore("counter", {
   state: () => {
    return { 
        count: 0 
    };
   },
   actions: {
    randomize() {
        let MAX_VAL = 100;
        let MIN_VAL = -100;
        this.count = Math.floor(Math.random() * (MAX_VAL - MIN_VAL + 1) + MIN_VAL);
    },
    increment(amount) {
        this.count = this.count + amount;
    },
    decrement(amount) {
        this.count -= amount;
    },
    reset() {
        this.count = 0;
    }
   },
   getters: {
    oddOrEven: (state) => {
        if (state.count %2 === 0) return 'even'
        return 'odd'
    },
    getCount: () => {
        return this.count;
    }
   }
});