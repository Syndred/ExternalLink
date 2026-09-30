# Standalone ExternalLink core

The local application imports these modules directly. It does not load any code
from `extension/`, and the form engine requires explicit host services instead of
Chrome extension runtime/storage APIs.

The initial library and form implementation were extracted from the production
extension at e2f339056e4564f49079a9de0319987252f3b2cc. Existing extension files remain
untouched as a rollback archive until the complete live acceptance gates pass.
New application changes belong here; archived copies are not a second application
engine to maintain. The temporary old workbench presentation will be replaced in
the four-page application phase.

Preparation AI runs inside the original executor job and returns control to it.
Only the executor creates a final submission boundary and submits; uncertain
outcomes stay verification-only. agent-browser binds the registered task target
on the original browser. Embedded forms retain the same task and scoped frame.
