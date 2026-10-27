import {AsyncLocalStorage} from 'node:async_hooks'
export const forkScope=new AsyncLocalStorage()
