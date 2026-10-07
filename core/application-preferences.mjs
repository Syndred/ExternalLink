export const applicationSettingKeys=Object.freeze(['domainBlacklist','targetFilters','cfgName','cfgEmail','cfgCommentTemplate','cfgPingIndex','autoFillOnVisit','cfgConcurrency','unattendedPreferences','linkMonitorSchedule','autoSubmitDirectoryListings','autoSubmitStandardWpComments']);
// The original monitor rounded and clamped the interval, and only literal
// false disabled it. Do not add a default plan to a source with no old keys.
export function normalizeLegacyPreferences(documents){
 if(documents.linkMonitorSchedule!==undefined||!['linkMonitorEnabled','linkMonitorMinutes'].some(key=>Object.hasOwn(documents,key)))return documents;
 const parsed=documents.linkMonitorMinutes===undefined?1440:Number(documents.linkMonitorMinutes),minutes=Number.isFinite(parsed)?Math.min(10080,Math.max(15,Math.round(parsed))):1440;
 return{...documents,linkMonitorSchedule:{enabled:documents.linkMonitorEnabled!==false,minutes}};
}
export function monitorSchedule(documents){return normalizeLegacyPreferences(documents).linkMonitorSchedule||{enabled:true,minutes:1440};}
