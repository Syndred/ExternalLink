export function canRetryNoAction(task, input) {
  if(task.url==='https://10015.io/product-finder/submit' && task.status==='submitted_unconfirmed' && task.siteStatus==='sent_unconfirmed' &&
     task.reason==='fill_only' && input.expectedReason==='fill_only' && !!task.attemptBoundary && task.attemptBoundary===input.expectedAttemptBoundary &&
     !task.guardedFillRecovery && !task.receipt && !(task.networkResponses||[]).length &&
     task.submitResult?.fillOnly===true && task.submitResult?.manual===true && task.submitResult?.reason==='fill_only' &&
     task.submitResult?.clickedSubmit!==true && !(task.submitResult?.networkResponses||[]).length && task.validation?.allValid &&
     task.selectedPickers?.['#pricing']==='Free' && task.selectedPickers?.['#category']==='AI')return true;
  const noClick = task.submitResult?.clickedSubmit === false || task.submitResult?.reason === 'no_submit_button';
  const searchOnly = task.attentionType === 'wrong_form' &&
    (task.actualSubmission?.fields || []).length === 0 && !task.fill?.filledCount;
  return task.status === 'needs_manual' && task.siteStatus === 'not_submitted' &&
    !!task.attemptBoundary && task.attemptBoundary === input.expectedAttemptBoundary &&
    task.reason === input.expectedReason && !!input.expectedReason && !task.receipt &&
    !task.noActionRecovery && !(task.networkResponses || []).length && (noClick || searchOnly);
}
