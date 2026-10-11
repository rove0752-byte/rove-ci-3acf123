/** Deliberately no URL, cookie, script, credential or external submission API. */
export interface BrowserProvider {
 readonly name:string;
 snapshot(document:{title:string;text:string},signal:AbortSignal):Promise<{title:string;text:string;provider:string}>;
}
export class LocalOfflineBrowser implements BrowserProvider {
 readonly name='local-offline';
 async snapshot(document:{title:string;text:string},signal:AbortSignal){
  signal.throwIfAborted();
  return {...document,provider:this.name};
 }
}
export function browserProvider(name='local-offline'):BrowserProvider {
 if(name!=='local-offline')throw new Error('Cloud and network browsers are not enabled');
 return new LocalOfflineBrowser();
}
