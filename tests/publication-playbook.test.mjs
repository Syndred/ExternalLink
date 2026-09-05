import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function load(file) {
  const context = { self: {}, URL, console };
  vm.createContext(context);
  vm.runInContext(readFileSync(file, "utf8"), context);
  return context.self;
}

const queueSelf = load("extension/lib/queue.js");
const Q = queueSelf.ExtLinkQueue;
const playbookSelf = load("extension/lib/playbooks.js");
playbookSelf.ExtLinkQueue = Q;
const P = playbookSelf.ExtLinkPlaybooks;

{
  assert.equal(Q.inferPublicationStatus({ evidence: "user confirmed" }), "submitted");
  assert.equal(
    Q.inferPublicationStatus({ evidence: "Submitted for Review" }),
    "pending_moderation",
  );
  assert.equal(
    Q.inferPublicationStatus({ evidence: "Your comment is awaiting moderation" }),
    "pending_moderation",
  );
  assert.equal(
    Q.inferPublicationStatus({ publicUrl: "https://startupbase.io/products/demo" }),
    "submitted",
    "a public URL alone is not published until live evidence or monitor upgrade",
  );
  assert.equal(
    Q.inferPublicationStatus({
      publicUrl: "https://startupbase.io/products/demo",
      evidence: "Launched this week",
    }),
    "published",
  );
  assert.equal(
    Q.inferPublicationStatus({ publicUrl: "https://example.com/submit" }),
    "submitted",
    "submit entry pages must not count as published",
  );
  assert.equal(
    Q.inferPublicationStatus({
      publicationStatus: "submitted",
      publicUrl: "https://startupbase.io/products/demo",
    }),
    "submitted",
    "explicit submitted must not be inferred away",
  );
}

{
  const submitted = Q.buildSuccessRecord({
    destinationUrl: "https://thejoai.com/aitools/submissions/",
    profileId: "RainbowPetAI",
    evidence: "form filled",
  });
  assert.equal(submitted.status, "success");
  assert.equal(submitted.publicationStatus, "submitted");
  assert.equal(Q.isSubmissionSuccessful({ [`${submitted.destinationKey}::RainbowPetAI`]: submitted }, submitted.destinationKey, "RainbowPetAI"), true);

  const pending = Q.buildSuccessRecord({
    destinationUrl: "https://thejoai.com/aitools/submissions/",
    profileId: "RainbowPetAI",
    evidence: "Submitted for Review",
  });
  assert.equal(pending.publicationStatus, "pending_moderation");

  const published = Q.applyPublicationUpgrade(pending, "published", {
    publicUrl: "https://thejoai.com/aitools/rainbowpetai",
  });
  assert.equal(published.publicationStatus, "published");
  assert.equal(published.status, "success");

  const downgraded = Q.applyPublicationUpgrade(published, "submitted");
  assert.equal(downgraded.publicationStatus, "published", "publication status must only move forward");
}

{
  const thejo = P.lookup("https://www.thejoai.com/aitools/submissions/");
  assert.equal(thejo?.id, "thejoai");
  const classified = P.classifyEvidence("Excellent submission +100 points. Submitted for Review", thejo);
  assert.equal(classified.publicationStatus, "pending_moderation");
  assert.equal(classified.playbookId, "thejoai");
  assert.equal(classified.matched, true);

  const unknown = P.lookup("https://random-blog.example/post/1");
  assert.equal(unknown, null);
  const fallback = P.classifyEvidence("Thanks for the comment, it is awaiting moderation", null);
  assert.equal(fallback.publicationStatus, "pending_moderation");
  const unmatched = P.classifyEvidence("Just a long blog post about tools and comments", null);
  assert.equal(unmatched.matched, false);
  assert.equal(unmatched.evidence, "", "unmatched page text must not become success evidence");
}

{
  const merged = Q.mergePublicationFields(
    { publicationStatus: "submitted", publicUrl: "", evidenceUrl: "" },
    { publicationStatus: "published", publicUrl: "https://example.com/p", evidenceUrl: "" },
  );
  assert.equal(merged.publicationStatus, "published");
  assert.equal(merged.publicUrl, "https://example.com/p");
}

console.log("publication and playbook tests passed");
