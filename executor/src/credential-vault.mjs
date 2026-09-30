import { AsyncEntry } from '@napi-rs/keyring';import {createHash} from 'node:crypto';import path from 'node:path';
export class CredentialVault{
 constructor(scope){const identity=path.isAbsolute(scope)?path.normalize(scope):scope;this.account=createHash('sha256').update(identity).digest('hex');}
 entry(name){if(!/^[a-z0-9_-]+$/.test(name))throw Error('无效凭据身份');return new AsyncEntry('ExternalLink',this.account+':'+name,{linux:{store:'secret-service'}});}
 async read(name){const value=await this.entry(name).getPassword();return value?JSON.parse(value):null;}
 async write(name,value){await this.entry(name).setPassword(JSON.stringify(value));}
 async remove(name){return this.entry(name).deleteCredential();}
}
