// Checks actual values before the irreversible third-party submit boundary.
export function assessSubmissionQuality(report, profile) {
  const brand = String(profile?.name || profile?.fields?.Name || '').trim().toLowerCase();
  const facts = profile?.fields || {};
  const issues = [];
  const productHost = (() => { try { return new URL(profile?.url || facts.Url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } })();
  const isSearch=field=>field.type==='search'||/^(?:search\b|query\b|搜索|检索)/i.test(String(field.label||'').trim())||field.name==='s';
  const hasIdentity = (report?.fields || []).some(field => {
    if(isSearch(field))return false;
    const value = String(field.value || '').trim();
    if (brand && value.toLowerCase() === brand) return true;
    if (!productHost || !/\b(?:url|website|link)\b|网址|链接/.test(`${field.label || ''} ${field.name || ''}`.toLowerCase())) return false;
    try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase() === productHost; } catch { return false; }
  });
  if (!hasIdentity) issues.push('表单没有核实的产品名称或网址，禁止提交搜索框或空表单');
  for (const field of report?.fields || []) {
    const label = `${field.label || ''} ${field.name || ''}`.toLowerCase();
    const value = String(field.value || '').trim();
    if(value&&isSearch(field))issues.push('站内搜索控件不是投稿字段，禁止提交');
    if (/产品名称|工具名称|\b(?:tool|product|app)\s+name\b/.test(label) && brand && value && value.toLowerCase() !== brand) {
      issues.push(`产品名称与资料品牌不一致：${field.label}`);
    }
    if (/标签|关键词|\b(?:tags?|keywords?|hashtags?)\b/.test(label) && value && (value.length > 240 || value.split(/\s+/).length > 25)) {
      issues.push(`标签字段疑似被填入长文案：${field.label}`);
    }
    if ((field.type === 'select-one' || field.type === 'combobox') && /分类|类别|\bcategory\b/.test(label) &&
        (!value || /^(?:0|选择|请选择|select|choose|pick|please|--)/i.test(value))) {
      issues.push(`分类仍是占位项：${field.label}`);
    }
    if (/\b(?:phone|telephone|mobile|whatsapp)\b/.test(label) && value && !(/^\+?[\d\s().-]{7,25}$/.test(value) && (value.match(/\d/g) || []).length >= 7)) {
      issues.push(`电话字段格式与资料不符：${field.label}`);
    }
    if (/\b(?:first\s+name|last\s+name|your\s+name|contact\s+name|company\s+name)\b/.test(label) &&
        brand && value.toLowerCase() === brand && ![facts['Contact person'], facts['Contact Name'], facts.Founder, facts.Company].some(x => String(x || '').trim().toLowerCase() === brand)) {
      issues.push(`身份字段被产品名替代：${field.label}`);
    }
  }
  return issues;
}
