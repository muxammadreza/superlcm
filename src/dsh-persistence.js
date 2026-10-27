// Released DSH hosts expose either a service class or a lifecycle plugin.
export async function mountDshPersistence(ctx,module,config){
  if(typeof module.default==='function')return new module.default(ctx,config)
  if(typeof module.apply!=='function')throw Error('DSH persistence interface is unavailable')
  const fork=ctx.plugin(module,config)
  await fork.await()
  if(!ctx.sessionPersistence)throw Error('DSH persistence service did not become ready')
  return ctx.sessionPersistence
}
