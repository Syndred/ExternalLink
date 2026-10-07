import './profiles.js';
import {applyOriginalCloudMediaDefaults} from './original-cloud-media.mjs';

// Use the original profile's effective fill configuration. The asset catalogue
// also contains old versions and must never choose an execution attachment.
export function taskMediaReferences(profile,defaults) {
 const config=applyOriginalCloudMediaDefaults(globalThis.ExtLinkProfiles.buildAgentConfigFromProfile(profile),defaults),refs=[];
 const add=(ref,kind)=>{if(typeof ref==='string'&&ref.startsWith('cloud-media://'))refs.push({ref,kind});};
 add(config.logoUrl,'logo');add(config.featuredImage,'featured');
 for(const [index,ref]of (config.screenshots||[]).entries())add(ref,'screenshot'+(index+1));
 return refs;
}

export function selectedFrozenPngLogo(profile,manifest,defaults) {
 const ref=applyOriginalCloudMediaDefaults(globalThis.ExtLinkProfiles.buildAgentConfigFromProfile(profile),defaults).logoUrl;
 if(!ref?.startsWith('cloud-media://'))return null;
 return manifest?.find(asset=>asset.asset_id===ref.slice(14)&&/\.png$/i.test(asset.file_name))||null;
}
