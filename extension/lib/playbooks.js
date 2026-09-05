// Known high-conversion directory playbooks: host recipes, evidence text, operator hints.
(function (global) {
  "use strict";

  const PLAYBOOKS = [
    {
      id: "thejoai",
      hosts: ["thejoai.com"],
      kind: "directory",
      title: "TheJOAI",
      notes: "富文本描述、主图有尺寸限制、缺省日期用今天、分类必选。最终提交仍人工点。",
      hints: ["核对主图预览", "分类必选", "日期若是今天请再看一眼"],
      pendingPatterns: ["submitted for review", "excellent submission"],
    },
    {
      id: "launching-next",
      hosts: ["launchingnext.com"],
      kind: "directory",
      title: "Launching Next",
      notes: "免费提交后常见 SUBMITTED / In Queue。不要买 Fast-Track。",
      hints: ["回执页应有队列编号"],
      pendingPatterns: ["submitted", "in queue"],
    },
    {
      id: "startupbase",
      hosts: ["startupbase.io"],
      kind: "directory",
      title: "StartupBase",
      notes: "成功看产品页 Pending Review，不要买 Launch now。",
      hints: ["去产品页确认 Pending Review"],
      pendingPatterns: ["pending review"],
    },
    {
      id: "aitools-inc",
      hosts: ["aitools.inc"],
      kind: "directory",
      title: "AITools.inc",
      notes: "Typeform 结束页 Thanks / we'll be in touch。不要走付费 Fast Lane。",
      hints: ["Typeform 结束页才算提交"],
      pendingPatterns: ["thanks", "we'll be in touch", "we will be in touch"],
    },
    {
      id: "uneed",
      hosts: ["uneed.best", "uneed.com"],
      kind: "directory",
      title: "Uneed",
      notes: "免费 waiting line 可能关闭。关闭就标付费，不要购买。",
      hints: ["确认仍是免费排队"],
      pendingPatterns: ["waiting", "in line", "added to"],
    },
    {
      id: "futuretools",
      hosts: ["futuretools.io"],
      kind: "directory",
      title: "FutureTools",
      notes: "表单和非标控件多，成功以人工确认为准。",
      hints: ["填完后等人工确认入账"],
      pendingPatterns: ["submitted", "thank you"],
    },
    {
      id: "sideprojectors",
      hosts: ["sideprojectors.com"],
      kind: "directory",
      title: "SideProjectors",
      notes: "确认页 under review，记下项目 ID。根入口和 /submit 是同一站。",
      hints: ["保存项目 ID", "确认页应显示审核中"],
      pendingPatterns: ["under review", "submitted"],
    },
    {
      id: "pitchwall",
      hosts: ["pitchwall.co"],
      kind: "directory",
      title: "PitchWall",
      notes: "账户里 Product Status: Under Review。免费 Launch，不买 Premium。",
      hints: ["回账户页看 Under Review"],
      pendingPatterns: ["under review", "product status"],
    },
    {
      id: "startupstash",
      hosts: ["startupstash.com"],
      kind: "directory",
      title: "StartupStash",
      notes: "Typeform 结束页 Thank you for applying。广告选 No。",
      hints: ["广告选 No", "结束页 Thank you"],
      pendingPatterns: ["thank you for applying", "thank you"],
    },
    {
      id: "producthunt",
      hosts: ["producthunt.com"],
      kind: "directory",
      title: "Product Hunt",
      notes: "高价值发布，按人工流程。公开产品页才算已上线。",
      hints: ["不要把讨论区评论当成产品上线"],
      pendingPatterns: ["under review", "scheduled"],
      publishedPatterns: ["launched this week", "launched in"],
    },
  ];

  const HOST_INDEX = new Map();
  for (const playbook of PLAYBOOKS) {
    for (const host of playbook.hosts || []) {
      HOST_INDEX.set(String(host).replace(/^www\./, "").toLowerCase(), playbook);
    }
  }

  function hostnameFrom(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
      return parsed.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return raw.replace(/^www\./, "").toLowerCase().split("/")[0];
    }
  }

  function lookupPlaybook(urlOrHost) {
    const host = hostnameFrom(urlOrHost);
    if (!host) return null;
    if (HOST_INDEX.has(host)) return HOST_INDEX.get(host);
    const parts = host.split(".");
    while (parts.length > 2) {
      parts.shift();
      const parent = parts.join(".");
      if (HOST_INDEX.has(parent)) return HOST_INDEX.get(parent);
    }
    return null;
  }

  function matchesAny(patterns, text) {
    const blob = String(text || "").toLowerCase();
    return (patterns || []).some((pattern) => blob.includes(String(pattern).toLowerCase()));
  }

  const GENERIC_PENDING =
    /awaiting moderation|held for moderation|pending moderation|comment is awaiting|under review|in queue|submitted for review|pending review|waiting line/;

  function snippetAround(text, needle) {
    const blob = String(text || "");
    const index = blob.toLowerCase().indexOf(String(needle || "").toLowerCase());
    if (index < 0) return blob.slice(0, 180);
    const start = Math.max(0, index - 40);
    return blob.slice(start, start + 180).trim();
  }

  function classifyEvidence(text, playbook) {
    const blob = String(text || "").replace(/\s+/g, " ").trim();
    const publishedHit = (playbook?.publishedPatterns || []).find((pattern) =>
      blob.toLowerCase().includes(String(pattern).toLowerCase()),
    );
    if (publishedHit) {
      return {
        publicationStatus: "published",
        evidence: snippetAround(blob, publishedHit),
        playbookId: playbook.id,
        matched: true,
      };
    }
    const pendingHit = (playbook?.pendingPatterns || []).find((pattern) =>
      blob.toLowerCase().includes(String(pattern).toLowerCase()),
    );
    if (pendingHit) {
      return {
        publicationStatus: "pending_moderation",
        evidence: snippetAround(blob, pendingHit),
        playbookId: playbook.id,
        matched: true,
      };
    }
    const generic = blob.match(GENERIC_PENDING);
    if (generic) {
      return {
        publicationStatus: "pending_moderation",
        evidence: snippetAround(blob, generic[0]),
        playbookId: playbook?.id || "",
        matched: true,
      };
    }
    return {
      publicationStatus: "submitted",
      evidence: "",
      playbookId: playbook?.id || "",
      matched: false,
    };
  }

  function listPlaybooks() {
    return PLAYBOOKS.map((item) => ({
      id: item.id,
      hosts: item.hosts,
      kind: item.kind,
      title: item.title,
      notes: item.notes,
    }));
  }

  global.ExtLinkPlaybooks = {
    PLAYBOOKS,
    lookup: lookupPlaybook,
    classifyEvidence,
    list: listPlaybooks,
  };
})(typeof self !== "undefined" ? self : window);
