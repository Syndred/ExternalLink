(function(global){
 'use strict';
 // Keep the original normalizeTargetFilters defaults, literal switches and
 // numeric conversion. DR/DA are additional workbench gates, when present.
 function normalize(raw){
  const source=raw&&typeof raw==='object'?raw:{},months=Number(source.minDomainAgeMonths),score=Number(source.minOpportunityScore);
  const filters={blacklistEnabled:source.blacklistEnabled!==false,minDomainAgeMonths:Number.isFinite(months)?Math.max(0,Math.min(months,600)):0,requireKnownDomainAge:source.requireKnownDomainAge===true,minOpportunityScore:Number.isFinite(score)?Math.max(0,Math.min(score,100)):0,showManualFillIcons:source.showManualFillIcons!==false,aiComments:source.aiComments!==false,aiCommentAllowLink:source.aiCommentAllowLink!==false};
  for(const key of ['minDr','minDa'])if(Object.hasOwn(source,key)){const value=Number(source[key]);filters[key]=Number.isFinite(value)?Math.max(0,Math.min(value,100)):0;}
  return filters;
 }
 global.ExtLinkTargetFilters={normalize};
})(typeof self!=='undefined'?self:globalThis);
