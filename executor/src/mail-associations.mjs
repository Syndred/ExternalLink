import {createHash} from 'node:crypto';
export function currentMailAssociations(store){
 const email=store.get('gmail')?.emailAddress;if(!email)return[];
 const prefix='gmailAssociation:'+createHash('sha256').update(email).digest('hex').slice(0,24)+':',ids=new Set(store.values('gmailAssociation:').filter(a=>a.emailAddress===email&&a.messageId).map(a=>a.messageId));
 // Canonical unmatched/candidate records also supersede historical associated aliases.
 return [...ids].map(id=>store.get(prefix+id)||store.get('gmailAssociation:'+id)).filter(a=>a?.emailAddress===email&&a.status==='associated');
}
