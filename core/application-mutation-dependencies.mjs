import {backupKeys,backupKeyDependencies} from './application-backup.mjs';
import {timelineDocumentKeys} from './original-timeline-mutation.mjs';

// Both device backends read the same original documents before applying a change.
export function applicationMutationDependencies(operation){
 if(!operation||typeof operation!=='object'||Array.isArray(operation))throw Object.assign(Error('缺少资料修改'),{status:400});
 const type=operation.type;
 if(type==='backup_key_merge'&&!backupKeys.includes(operation.key))throw Object.assign(Error('外链库字段未授权'),{status:403});
 const dependencies=['recover_local','backup_prepared_key'].includes(type)?[operation.key]
  :type==='pin'?['urlList']
  :type==='add_browser_url'?['urlList','deletedSubmissionKeys','siteAnnotations']
  :['clear_deleted','set_deleted'].includes(type)?['deletedSubmissionKeys']
  :type==='backup_merge'?backupKeys
  :type==='backup_key_merge'?backupKeyDependencies(operation.key)
  :type==='domain_metrics'?['domainMetricsCache']
  :['submify_refs','submify_import','create','import','edit'].includes(type)?['sheetTableData']
  :type==='monitor_result'?['submissionRecords','linkMonitorResults']
  :type==='monitor_publication'?['submissionRecords','linkMonitorResults','siteProfiles']
  :type==='automatic_mark'?['siteAnnotations','deletedSubmissionKeys']
  :['submify_gates','mark','clear_annotation','remove_queue','form_knowledge'].includes(type)?['siteAnnotations']
  :type==='preferences'?['siteAnnotations','siteProfiles']
  :type==='timeline'?timelineDocumentKeys
  :type==='settings'?[operation.key]
  :type==='profile_selection'?['siteProfiles',operation.key]
  :['profile','profile_create','profile_delete','profile_archive','profile_media','profile_order','form_learning'].includes(type)?['siteProfiles']:[];
 if(!dependencies.length)throw Object.assign(Error('不支持的外链库操作'),{status:400});
 if(dependencies.some(key=>!backupKeys.includes(key)))throw Object.assign(Error('外链库字段未授权'),{status:403});
 return [...new Set(dependencies)];
}
