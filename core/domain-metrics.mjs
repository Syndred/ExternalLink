export const domainMetricsTtl=7*24*60*60*1000,domainMetricsLimit=5000,domainMetricsBatch=20;
export function metricFetchedAt(record){const value=record?.fetchedAt;return value===undefined?Date.parse(record?.checkedAt||'')||0:Number(value)||0;}
export function freshDomainMetric(record,now=Date.now()){return !!record&&now-metricFetchedAt(record)<domainMetricsTtl;}
export function pruneDomainMetrics(cache){const entries=Object.entries(cache||{});if(entries.length<=domainMetricsLimit)return cache;entries.sort((a,b)=>metricFetchedAt(b[1])-metricFetchedAt(a[1]));return Object.fromEntries(entries.slice(0,domainMetricsLimit));}
