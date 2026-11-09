import {mkdirSync,lstatSync,chmodSync,openSync,closeSync,fstatSync,constants,existsSync} from 'node:fs'
const owned=stat=>typeof process.getuid!=='function'||stat.uid===process.getuid()
export function privateDirectory(path){
  mkdirSync(path,{recursive:true,mode:0o700})
  const stat=lstatSync(path)
  if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat))throw Error('Private directory must be owned by this user and not a symlink')
  if(process.platform!=='win32')chmodSync(path,0o700)
}
export function privateFile(path){
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('Private file cannot be a symlink')
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|(constants.O_NOFOLLOW||0),0o600)
  try{const stat=fstatSync(fd);if(!stat.isFile()||!owned(stat))throw Error('Private file must be a regular file owned by this user');if(process.platform!=='win32')chmodSync(path,0o600)}finally{closeSync(fd)}
}
