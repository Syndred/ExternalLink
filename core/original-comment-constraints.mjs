export function chooseCommentField(snapshot) {
    const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
    const candidates = fields.filter((field) => {
      const hint = [field?.label, field?.name, field?.id, field?.placeholder, field?.aria]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const type = String(field?.type || field?.tag || "").toLowerCase();
      const isTextControl = type === "textarea" || type === "text" || type === "div" || type === "contenteditable";
      return isTextControl && /comment|reply|review|message|feedback|body|thoughts|评论|回复|留言|正文/.test(hint);
    });
    candidates.sort((a, b) => {
      const score = (field) => {
        const hint = [field?.label, field?.name, field?.id, field?.placeholder, field?.aria]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (/(comment|reply|评论|回复)/.test(hint) ? 100 : 0) +
          (String(field?.type || field?.tag || "").toLowerCase() === "textarea" ? 20 : 0) +
          (field?.required ? 5 : 0);
      };
      return score(b) - score(a);
    });
    return candidates[0] || null;
  }
export function originalCommentMaximum(snapshot,prescan={}){const field=chooseCommentField(snapshot),maximum=Number(field?.constraints?.maxLength),fallback=Number(prescan.commentMaxLength);return Number.isFinite(maximum)&&maximum>0?maximum:Number.isFinite(fallback)&&fallback>0?fallback:null;}
export function assertOriginalCommentLength(text,snapshot,prescan){const maximum=originalCommentMaximum(snapshot,prescan);if(maximum!==null&&String(text).length>maximum)throw Error('评论超过当前页面字数上限，请先编辑');return maximum;}
